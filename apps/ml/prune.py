#!/usr/bin/env python3
import argparse
import logging
import os
import urllib.parse
from datetime import datetime, timedelta
import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prune old candidate models.")
    parser.add_argument("--days", type=int, default=7, help="Delete candidates older than this many days.")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be deleted without deleting.")
    return parser.parse_args()

def main() -> None:
    args = parse_args()
    
    # Load .env relative to the script location
    script_dir = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(script_dir, '.env'))
    
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logging.error("DATABASE_URL environment variable is required.")
        return

    cutoff = datetime.now() - timedelta(days=args.days)
    logging.info(f"Pruning CANDIDATE models created before {cutoff}")

    try:
        with psycopg.connect(db_url) as conn:
            with conn.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    "SELECT id, artifact_uri, trained_at FROM model_versions WHERE stage = 'CANDIDATE' AND trained_at < %s",
                    (cutoff,)
                )
                rows = cursor.fetchall()
                
                if not rows:
                    logging.info("No old candidates found to prune.")
                    return

                for row in rows:
                    model_id = row["id"]
                    uri = row["artifact_uri"]
                    
                    if args.dry_run:
                        logging.info(f"[DRY-RUN] Would delete {model_id} and artifact {uri}")
                        continue
                        
                    # Delete the file
                    if uri and uri.startswith("file://"):
                        try:
                            # Parse file URI
                            file_path = urllib.parse.unquote(urllib.parse.urlparse(uri).path)
                            # On Windows, urlparse might leave a leading slash like /C:/Users/...
                            if os.name == 'nt' and file_path.startswith('/'):
                                file_path = file_path[1:]
                                
                            if os.path.exists(file_path):
                                os.remove(file_path)
                                logging.info(f"Deleted file {file_path}")
                            else:
                                logging.warning(f"File {file_path} not found, skipping file deletion.")
                        except Exception as e:
                            logging.error(f"Failed to delete artifact for {model_id} at {uri}: {e}")
                    
                    # Delete the row
                    cursor.execute("DELETE FROM model_versions WHERE id = %s", (model_id,))
                    logging.info(f"Deleted database record for candidate model {model_id}")

            if not args.dry_run:
                conn.commit()

    except Exception as e:
        logging.error(f"Error during pruning: {e}")

if __name__ == "__main__":
    main()
