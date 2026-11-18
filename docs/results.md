# Results: tiering trial (PS1 example)

Measured on the PlayStation 1 example project with a token tracker that reads Claude Code transcripts. Costs are Claude Code's **API-equivalent estimates** of subscription usage, not bills.

| | Old model (5 cycles) | Tiered, run 1 | Tiered, run 2 |
|---|---|---|---|
| Team | Opus does everything, Opus reviewer per branch | Opus area leads, Sonnet builders, Haiku scouts, light lead review | same |
| Spend | $127.25 | $31.21 (one cycle) | $31.41 (one cycle) |
| Merged | 10 branches | 6 (3 were finished leftovers) | 4 goals (one integrated branch) |
| **Cost per merged goal** | **$12.72** | $5.20 – $10.40 | **$7.85** |
| Opus / Sonnet / Haiku / lead share | 87% / 0.2% / 0% / 13% | 48% / 35% / 1% / 15% | 56% / 33% / 1% / 10% |
| Unit tests | 114 → 423 | 423 → 709 | 709 → 827 |
| Cycle length | 11 min – 3 h 10 min | 1 h 54 min | 1 h 30 min |

Run 2 had no leftover work, so $7.85 vs $12.72 (about 38% cheaper per goal) is the cleaner comparison. The second run also kept quality checks on: the independent reviewer fired on risky branches, and QA found real gameplay problems that became the next milestone.

Caveats: two runs is a small sample; "a goal" varies in size; cost per goal is not value per goal. Measure on your own project before trusting these numbers.
