"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Crown, Swords, TrendingUp } from "lucide-react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";

interface CompetitionPoolMember {
  competition_group: string;
  role: "PRIMARY" | "SECONDARY" | "COMPETITOR";
  model_version_id: string;
  enrolled_at: string;
  last_rolling_macro_f1: string | number | null;
  last_evaluated_at: string | null;
  model_key: string;
  version: number;
  algorithm: string;
  stage: string;
  trained_at: string;
  promoted_at: string | null;
}

interface CompetitionDailyScore {
  model_version_id: string;
  score_date: string;
  predictions_settled: number;
  predictions_correct: number;
  accuracy: string | number | null;
  macro_f1: string | number | null;
  directional_hit_rate: string | number | null;
}

interface CompetitionPromotion {
  model_version_id: string;
  previous_model_version_id: string | null;
  comparison: Record<string, unknown>;
  promoted_at: string;
  model_key: string;
  version: number;
}

interface CompetitionEnvelope {
  data?: {
    pool?: CompetitionPoolMember[];
    dailyScores?: CompetitionDailyScore[];
    promotions?: CompetitionPromotion[];
  };
}

function asNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatScore(value: string | number | null): string {
  const parsed = asNumber(value);
  return parsed === null ? "—" : parsed.toFixed(4);
}

const roleStyles: Record<CompetitionPoolMember["role"], string> = {
  PRIMARY: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  SECONDARY: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  COMPETITOR: "border-white/10 bg-slate-900 text-slate-300",
};

/**
 * The live champion–challenger leaderboard. Every score here is a settled,
 * live outcome — a prediction judged against the candle that actually printed —
 * unlike the training-time holdout metrics in the registry below. Roles change
 * only through the scheduled daily competition, never from this view.
 */
export function ModelCompetition() {
  const [pool, setPool] = useState<CompetitionPoolMember[]>([]);
  const [dailyScores, setDailyScores] = useState<CompetitionDailyScore[]>([]);
  const [promotions, setPromotions] = useState<CompetitionPromotion[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadCompetition = useCallback(async (signal?: AbortSignal) => {
    return await getResearchJson("/models/competition", signal) as CompetitionEnvelope;
  }, []);

  const applyCompetition = useCallback((payload: CompetitionEnvelope) => {
    setPool(payload.data?.pool ?? []);
    setDailyScores(payload.data?.dailyScores ?? []);
    setPromotions(payload.data?.promotions ?? []);
    setError(null);
  }, []);

  const applyCompetitionError = useCallback((caught: unknown) => {
    if (isAbortError(caught)) return;
    setError(errorMessage(caught, "The model competition state could not be read."));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadCompetition(controller.signal).then(applyCompetition, applyCompetitionError);
    return () => controller.abort();
  }, [loadCompetition, applyCompetition, applyCompetitionError]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, CompetitionPoolMember[]>();
    for (const member of pool) {
      const members = byGroup.get(member.competition_group) ?? [];
      members.push(member);
      byGroup.set(member.competition_group, members);
    }
    return [...byGroup.entries()];
  }, [pool]);

  const recentDaysByModel = useMemo(() => {
    const byModel = new Map<string, CompetitionDailyScore[]>();
    for (const score of dailyScores) {
      const scores = byModel.get(score.model_version_id) ?? [];
      scores.push(score);
      byModel.set(score.model_version_id, scores);
    }
    return byModel;
  }, [dailyScores]);

  if (pool.length === 0 && !error) {
    return null;
  }

  return (
    <Reveal>
      <GlassPanel className="border-amber-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-amber-950/20 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Swords className="h-5 w-5 text-amber-300" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-amber-200">
            Daily Model Competition
          </h2>
          <span className="text-xs text-slate-400">
            live settled outcomes · challenger promotes after consistent outperformance
          </span>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-semibold text-rose-200">
            {error}
          </div>
        )}

        {groups.map(([group, members]) => (
          <div className="mb-4" key={group}>
            <div className="mb-2 truncate text-xs font-semibold text-slate-400" title={group}>{group}</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="px-2 py-1 font-semibold">Role</th>
                    <th className="px-2 py-1 font-semibold">Version</th>
                    <th className="px-2 py-1 font-semibold">Algorithm</th>
                    <th className="px-2 py-1 font-semibold">Rolling macro-F1</th>
                    <th className="px-2 py-1 font-semibold">Recent days (settled · macro-F1)</th>
                    <th className="px-2 py-1 font-semibold">Enrolled</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const recent = (recentDaysByModel.get(member.model_version_id) ?? []).slice(0, 5);
                    return (
                      <tr className="border-t border-white/5" key={member.model_version_id}>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-bold ${roleStyles[member.role]}`}>
                            {member.role === "PRIMARY" && <Crown className="h-3 w-3" />}
                            {member.role === "SECONDARY" && <TrendingUp className="h-3 w-3" />}
                            {member.role}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 font-bold text-white">v{member.version}</td>
                        <td className="px-2 py-1.5 text-slate-300">{member.algorithm}</td>
                        <td className="px-2 py-1.5 font-bold text-cyan-200">{formatScore(member.last_rolling_macro_f1)}</td>
                        <td className="px-2 py-1.5 text-slate-300">
                          {recent.length === 0
                            ? <span className="text-slate-500">no settled predictions yet</span>
                            : recent.map((day) => (
                              <span className="mr-2 whitespace-nowrap" key={day.score_date} title={day.score_date}>
                                {day.score_date.slice(5)}: {day.predictions_settled}·{formatScore(day.macro_f1)}
                              </span>
                            ))}
                        </td>
                        <td className="px-2 py-1.5 text-slate-400">{new Date(member.enrolled_at).toLocaleDateString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {promotions.length > 0 && (
          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="mb-1 text-xs font-semibold text-slate-400">Promotion history</div>
            <ul className="space-y-1 text-xs text-slate-300">
              {promotions.map((promotion) => (
                <li key={`${promotion.model_version_id}-${promotion.promoted_at}`}>
                  <span className="font-bold text-amber-200">v{promotion.version}</span>
                  {" promoted "}
                  <span className="text-slate-400">{new Date(promotion.promoted_at).toLocaleString()}</span>
                  {typeof promotion.comparison?.method === "string" && (
                    <span className="ml-2 rounded border border-white/10 bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {String(promotion.comparison.method)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </GlassPanel>
    </Reveal>
  );
}
