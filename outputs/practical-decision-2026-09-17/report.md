# Practical run decision verification — 2026-09-17

Implemented the run-window rain decision in `assets/weather-domain.mjs` and made the server and mobile cache path consume the same evaluator.

## Policy verified

- Three real samples (departure, 30 minutes, return) are required for a run mode. Any unavailable/demo sample or missing/nonfinite amount returns `unknown` with `자료가 부족해 판단하기 어려워요`.
- Priority is snow/sleet → heavy rain (peak or cumulative ≥3mm) → trusted approach CCTV rain (2 red, 1 yellow) → rain (peak or cumulative ≥1mm) → wet/recovering surface or two trusted wet-surface CCTV observations → chance ≥60% → model disagreement → low (cumulative and peak ≤0.2mm) → light.
- Official probability is the maximum inside the selected window. Model probability is the maximum of each selected sample's current-time model mean; next-hour probability/amount and legacy aggregate spread/votes are excluded from the verdict.
- Current model disagreement is spread ≥40 or wet-vote ratio 25–75% using only in-window model entries.
- Amounts keep the existing one-decimal rounding. If the displayed cumulative amount is `0`, the classifier cannot choose the affirmative light-rain headline; it falls through to low, probability, or uncertainty as applicable. Recent recovery can produce yellow surface caution but cannot force red.
- CCTV decision evidence requires `cameraUsable !== false`, confidence `≥ 0.65`, analyzed rain state, and the existing south/southwest/west locality rule for approach rain. Cached mobile modes are recomputed from samples, ignoring legacy decision levels.

## Before / after examples

| Input | Previous behavior | New shared result |
| --- | --- | --- |
| selected samples 0/0/0mm, official POP 80% | old mobile amount ladder could show a positive weak-rain headline with a 0mm summary | yellow `probability`: `비 올 가능성이 있어요` |
| selected samples 0.3/0.3/0.3mm, low POP | separate UI/server thresholds could disagree | green `light`: `약한 비가 예상돼요`, shared 0.3mm |
| selected samples 0.2/0.2/3mm | earlier light sample could hide later severity | red `rain_heavy`: `비가 많아 러닝을 미루는 게 좋아요` |
| old cached `decision.level=red` with raw 0mm/POP 80% | cached red verdict persisted | mobile normalizer recomputes yellow `probability` |
| previous heavy rain with current 0mm | recovery path forced red | yellow `surface`: `노면이 젖어 있을 수 있어요` |

## Validation

- `node --check server.mjs`
- `node --check assets/weather-domain.mjs`
- `node --check assets/mobile.js`
- `node --test` — 29 passed (19 weather decision cases + 10 auto-refresh regressions)
- Playwright CLI on isolated port `4199`: rendered 0mm/high-POP fixture showed `decision-hero yellow`, title `비 올 가능성이 있어요`, and 0mm; mutated legacy cache remapped to the same yellow result; normal 0.3mm fixture showed `decision-hero green`, title `약한 비가 예상돼요`, and 0.3mm. Screenshots are under `output/playwright/practical-decision/.playwright-cli/`.

## Limitations

The thresholds are app product heuristics for consistent run presentation. They are not official weather warnings or medical/safety advice. Live provider coverage and actual CCTV image availability still determine whether a real response is complete.
