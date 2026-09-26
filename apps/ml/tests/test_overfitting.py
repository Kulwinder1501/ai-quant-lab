from __future__ import annotations

import unittest

from ai_quant_lab_ml.overfitting import (
    OverfittingCheckError,
    TrialEvidence,
    no_skill_macro_f1_p_value,
    rank_trials_by_overfitting_risk,
    sidak_adjusted_p_value,
)


BALANCED_COUNTS = {"BEARISH": 500, "NEUTRAL": 500, "BULLISH": 500}


class NoSkillMacroF1PValueTests(unittest.TestCase):
    def test_a_score_at_the_random_baseline_is_unsurprising(self) -> None:
        p_value = no_skill_macro_f1_p_value(
            class_counts=BALANCED_COUNTS, observed_macro_f1=1 / 3, trials=2000, random_state=1,
        )

        self.assertGreater(p_value, 0.3)

    def test_a_near_perfect_score_is_essentially_impossible_by_chance(self) -> None:
        p_value = no_skill_macro_f1_p_value(
            class_counts=BALANCED_COUNTS, observed_macro_f1=0.99, trials=2000, random_state=1,
        )

        self.assertEqual(p_value, 0.0)

    def test_a_smaller_validation_set_makes_the_same_score_less_surprising(self) -> None:
        """Noise is larger with fewer rows, so the same score should look more like luck."""

        small = {"BEARISH": 10, "NEUTRAL": 10, "BULLISH": 10}
        large = {"BEARISH": 2000, "NEUTRAL": 2000, "BULLISH": 2000}

        p_small = no_skill_macro_f1_p_value(class_counts=small, observed_macro_f1=0.45, trials=4000, random_state=7)
        p_large = no_skill_macro_f1_p_value(class_counts=large, observed_macro_f1=0.45, trials=4000, random_state=7)

        self.assertGreater(p_small, p_large)

    def test_rejects_a_single_class(self) -> None:
        with self.assertRaises(OverfittingCheckError):
            no_skill_macro_f1_p_value(class_counts={"ONLY": 100}, observed_macro_f1=0.5, trials=100)

    def test_rejects_a_non_finite_score(self) -> None:
        with self.assertRaises(OverfittingCheckError):
            no_skill_macro_f1_p_value(class_counts=BALANCED_COUNTS, observed_macro_f1=float("nan"), trials=100)

    def test_is_deterministic_for_a_fixed_seed(self) -> None:
        first = no_skill_macro_f1_p_value(class_counts=BALANCED_COUNTS, observed_macro_f1=0.4, trials=500, random_state=3)
        second = no_skill_macro_f1_p_value(class_counts=BALANCED_COUNTS, observed_macro_f1=0.4, trials=500, random_state=3)

        self.assertEqual(first, second)


class SidakAdjustedPValueTests(unittest.TestCase):
    def test_one_trial_leaves_the_p_value_unchanged(self) -> None:
        self.assertAlmostEqual(sidak_adjusted_p_value(0.02, independent_trials=1), 0.02, places=10)

    def test_more_trials_make_the_same_single_trial_score_look_more_like_chance(self) -> None:
        few = sidak_adjusted_p_value(0.01, independent_trials=5)
        many = sidak_adjusted_p_value(0.01, independent_trials=113)

        self.assertLess(few, many)
        # With 113 nearly-independent tries at a 1% single-shot chance, seeing
        # at least one "hit" is close to certain rather than still rare.
        self.assertGreater(many, 0.6)

    def test_rejects_a_p_value_outside_the_unit_interval(self) -> None:
        with self.assertRaises(OverfittingCheckError):
            sidak_adjusted_p_value(1.5, independent_trials=10)

    def test_rejects_a_non_positive_trial_count(self) -> None:
        with self.assertRaises(OverfittingCheckError):
            sidak_adjusted_p_value(0.05, independent_trials=0)


class RankTrialsByOverfittingRiskTests(unittest.TestCase):
    def test_a_registry_of_no_skill_scores_all_lands_far_from_significant(self) -> None:
        trials = [
            TrialEvidence(model_key=f"idea-{i}", algorithm="logistic", macro_f1=0.34, sample_count=1500, class_counts=BALANCED_COUNTS)
            for i in range(20)
        ]

        ranked = rank_trials_by_overfitting_risk(trials, simulation_trials=1000, random_state=9)

        self.assertEqual(len(ranked), 20)
        for verdict in ranked:
            self.assertGreater(verdict.adjusted_p_value, 0.5)

    def test_one_standout_score_ranks_first_even_among_many_weak_trials(self) -> None:
        weak_trials = [
            TrialEvidence(model_key=f"idea-{i}", algorithm="logistic", macro_f1=0.34, sample_count=1500, class_counts=BALANCED_COUNTS)
            for i in range(30)
        ]
        standout = TrialEvidence(
            model_key="idea-standout", algorithm="lightgbm", macro_f1=0.65, sample_count=1500, class_counts=BALANCED_COUNTS,
        )

        ranked = rank_trials_by_overfitting_risk([*weak_trials, standout], simulation_trials=1000, random_state=11)

        self.assertEqual(ranked[0].model_key, "idea-standout")
        self.assertLess(ranked[0].adjusted_p_value, ranked[1].adjusted_p_value)

    def test_empty_registry_ranks_to_an_empty_list(self) -> None:
        self.assertEqual(rank_trials_by_overfitting_risk([]), [])


if __name__ == "__main__":
    unittest.main()
