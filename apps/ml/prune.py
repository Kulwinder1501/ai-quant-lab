#!/usr/bin/env python3
"""Delete stale CANDIDATE model rows and their artifacts.

Ordering matters here and it is not the obvious one. The database row is deleted
and committed *first*, and only then is the ``.pkl`` unlinked.

Removing the file first -- the original order -- lost data on any failure. Every
delete ran inside one transaction, so a single row that could not be deleted
aborted the whole batch and rolled every row back, while the files already
unlinked were gone for good. The result was surviving rows pointing at artifacts
that no longer existed, which is strictly worse than either doing nothing or
finishing the job. Committing the row first means the only failure mode left is an
orphaned file, which is recoverable and merely wastes disk.

``model_predictions.model_version_id`` is ``ON DELETE RESTRICT``, so a candidate
that ever produced a prediction cannot be deleted. That is a deliberate FK, not a
bug to work around: those predictions are the audit trail. Such candidates are
skipped and reported rather than being allowed to abort the run.
"""

from __future__ import annotations

import argparse
import logging
import os
import urllib.parse
from datetime import UTC, datetime, timedelta

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

_SELECT_STALE_CANDIDATES = """
    SELECT model_versions.id, model_versions.model_key, model_versions.artifact_uri, model_versions.trained_at
    FROM model_versions
    WHERE model_versions.stage = 'CANDIDATE'
      AND model_versions.trained_at < %s
      -- Excluded in SQL rather than discovered via a failed DELETE, so one
      -- referenced candidate cannot abort the batch.
      AND NOT EXISTS (
        SELECT 1 FROM model_predictions
        WHERE model_predictions.model_version_id = model_versions.id
      )
      -- Also ON DELETE RESTRICT, so a candidate referenced here cannot be deleted
      -- either. Omitting this would make prune fail on any candidate that produced
      -- a non-directional prediction.
      AND NOT EXISTS (
        SELECT 1 FROM auxiliary_model_predictions
        WHERE auxiliary_model_predictions.model_version_id = model_versions.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_promotions
        WHERE model_promotions.model_version_id = model_versions.id
           OR model_promotions.previous_model_version_id = model_versions.id
      )
    ORDER BY model_versions.trained_at ASC
"""

_COUNT_REFERENCED_CANDIDATES = """
    SELECT COUNT(*) AS referenced
    FROM model_versions
    WHERE model_versions.stage = 'CANDIDATE'
      AND model_versions.trained_at < %s
      AND (
        EXISTS (
          SELECT 1 FROM model_predictions
          WHERE model_predictions.model_version_id = model_versions.id
        )
        OR EXISTS (
          SELECT 1 FROM auxiliary_model_predictions
          WHERE auxiliary_model_predictions.model_version_id = model_versions.id
        )
        OR EXISTS (
          SELECT 1 FROM model_promotions
          WHERE model_promotions.model_version_id = model_versions.id
             OR model_promotions.previous_model_version_id = model_versions.id
        )
      )
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prune old candidate models.")
    parser.add_argument("--days", type=int, default=7, help="Delete candidates older than this many days.")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be deleted without deleting.")
    return parser.parse_args()


def artifact_path_from_uri(uri: str | None) -> str | None:
    """Resolve a ``file://`` artifact URI to a local path, or None if it is not one."""

    if not uri or not uri.startswith("file://"):
        return None
    file_path = urllib.parse.unquote(urllib.parse.urlparse(uri).path)
    # On Windows urlparse leaves a leading slash, as in "/C:/Users/...".
    if os.name == "nt" and file_path.startswith("/"):
        file_path = file_path[1:]
    return file_path


def main() -> int:
    args = parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(script_dir, ".env"))

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logging.error("DATABASE_URL environment variable is required.")
        return 1

    # Timezone-aware: trained_at is TIMESTAMPTZ, and a naive local datetime is
    # interpreted in the session timezone, shifting the cutoff by the UTC offset.
    cutoff = datetime.now(UTC) - timedelta(days=args.days)
    logging.info("Pruning CANDIDATE models trained before %s", cutoff.isoformat())

    try:
        with psycopg.connect(db_url) as conn:
            with conn.cursor(row_factory=dict_row) as cursor:
                cursor.execute(_COUNT_REFERENCED_CANDIDATES, (cutoff,))
                referenced_row = cursor.fetchone()
                referenced = 0 if referenced_row is None else int(referenced_row["referenced"])

                cursor.execute(_SELECT_STALE_CANDIDATES, (cutoff,))
                rows = cursor.fetchall()

            # Reported explicitly. A silent skip reads as "nothing to prune" when
            # in fact stale candidates were deliberately retained.
            if referenced:
                logging.info(
                    "Retained %d stale candidate(s) still referenced by predictions or promotions.", referenced
                )

            if not rows:
                logging.info("No prunable candidates found.")
                return 0

            if args.dry_run:
                for row in rows:
                    logging.info(
                        "[DRY-RUN] Would delete %s (%s, trained %s) and artifact %s",
                        row["id"], row["model_key"], row["trained_at"], row["artifact_uri"],
                    )
                return 0

            deleted_ids: list[tuple[str, str | None]] = []
            failures = 0
            for row in rows:
                model_id = row["id"]
                # One transaction per model, so a failure on one candidate leaves
                # the others pruned instead of rolling the whole batch back.
                try:
                    with conn.transaction():
                        with conn.cursor() as cursor:
                            cursor.execute("DELETE FROM model_versions WHERE id = %s", (model_id,))
                except psycopg.Error as error:
                    failures += 1
                    logging.error("Could not delete model_versions row %s, keeping its artifact: %s", model_id, error)
                    continue
                deleted_ids.append((model_id, artifact_path_from_uri(row["artifact_uri"])))
                logging.info("Deleted database record for candidate model %s", model_id)

            # Files only after their rows are committed.
            for model_id, file_path in deleted_ids:
                if file_path is None:
                    continue
                try:
                    os.remove(file_path)
                    logging.info("Deleted artifact %s", file_path)
                except FileNotFoundError:
                    logging.warning("Artifact %s was already absent.", file_path)
                except OSError as error:
                    logging.error("Orphaned artifact %s for deleted model %s: %s", file_path, model_id, error)
                    failures += 1

            logging.info("Pruned %d candidate model(s).", len(deleted_ids))
            return 1 if failures else 0

    except psycopg.Error as error:
        logging.error("Error during pruning: %s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
