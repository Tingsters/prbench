# Related work

Research and tools relevant to judging the pull requests AI coding agents produce, collected in October 2026 to decide whether prbench needed to exist. **It did: no existing benchmark, dataset or eval tool scores the whole PR a PR-writing tool produces against a baseline.** The sections below say what each source offers and what it lacks.

Each entry is marked by how well it was checked during that research:

- **[read]**: the paper's abstract or page was read; numbers come from it.
- **[search]**: seen only in search results; check before citing.
- **[memory]**: recalled, not checked; verify before citing.

Most 2026 papers below are MSR '26 preprints. Several report figures that differ between versions or subsets, so cite a specific version.

## What the findings mean for prbench

| Finding | Where it shows up in prbench |
|---|---|
| A description that doesn't match its diff is the clearest sign of a bad agent PR, and the most common mismatch is describing changes that weren't made (Gong et al.). | Claim-by-claim accuracy against the diff is the primary metric. Gong et al.'s labelled PRs test the accuracy checker. |
| Reviewers value purpose, explanation of the code, and why as well as what; saying what feedback is wanted best predicts merge and engagement (Pirouzkhah et al.; Pascarella et al.; Tian et al.). | Rubric items for purpose, rationale, orientation and requested feedback. |
| Developers add intent, testing information and links to AI-written descriptions (Xiao et al.). | Rubric items for validation and links; fact sheets record what was and wasn't tested. |
| BLEU, ROUGE and METEOR track human judgment poorly for commit messages (Tao et al.; JetBrains 2025; Zeng et al.). | No n-gram overlap metrics. LLM judges, calibrated against people. |
| LLM judges with reasoning and examples approach human agreement (Zeng et al.; Wu et al.) but show position, length and self-preference bias (Zheng et al.). | Pairwise judging in both orders, judges from two model families, word counts reported, human calibration. |
| Merged/rejected is a weak signal: many rejections aren't the agent's fault or have no stated reason (Peralta et al.; Nakashima et al.). | Outcome data is used only as an outside check, with "merged as-is" and edit distance preferred (Watanabe et al.; JetBrains 2025). |

## Agent-written PRs: acceptance, review and rejection

- **Li, Zhang, Hassan. "The Rise of AI Teammates in Software Engineering (SE) 3.0: How Autonomous Coding Agents Are Reshaping Software Engineering." 2025. arXiv [2507.15003](https://arxiv.org/abs/2507.15003). [read]**
  - Introduces the **AIDev** dataset ([hao-li/AIDev](https://huggingface.co/datasets/hao-li/AIDev), CC-BY-4.0). The paper describes about 456K PRs; the dataset page now lists about 932K PRs from Codex, Copilot, Claude Code, Cursor, Jules and Devin.
  - **AIDev-pop** (repositories with more than 100 stars, about 33.6K PRs) adds commits, diffs, reviews, review comments and timelines.
  - Acceptance in the paper's table: human 76.8%, Codex 65.3%, Claude Code 52.5%, Cursor 51.4%, Devin 48.9%, Copilot 38.2%. The paper's own text gives slightly different figures.
  - **Gap:** no agent session logs, so PR tools can't be rerun on its PRs. Useful for observational checks.
- **Watanabe, Li, Kashiwa, Reid, Iida, Hassan. "On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub." 2025, revised 2026. arXiv [2509.14745](https://arxiv.org/abs/2509.14745). [read]**
  - 567 Claude Code PRs in 157 projects; 83.8% merged. Of those, 54.9% were merged unchanged and 45.1% needed human revision.
  - "Merged as-is vs. merged after revision" is a finer outcome signal than merged or not.
- **Gong, Pinna, Bian, Zhang. "Analyzing Message-Code Inconsistency in AI Coding Agent-Authored Pull Requests." MSR '26 Mining Challenge. arXiv [2601.04886](https://arxiv.org/abs/2601.04886). [read]**
  - 23,247 agent PRs; 974 labelled by hand. 1.7% had highly inconsistent descriptions.
  - Those were accepted 28.3% of the time versus 80.0%, and took 55.8h to merge versus 16.0h.
  - Eight mismatch types; the largest (45.4%) is "description claims changes that weren't implemented".
  - **Most directly relevant source.** The taxonomy and labelled set can test prbench's accuracy checker.
- **Pham, Ghaleb. "Code Change Characteristics and Description Alignment: Agentic vs Human PRs." MSR '26. arXiv [2601.17627](https://arxiv.org/abs/2601.17627). [read]**
  - 647 agent and 571 human PRs. Measures description-to-commit similarity with embeddings (agents 0.86, humans 0.88) and patch-to-message similarity.
  - Commit message length is the strongest predictor of description quality: agents tend to summarize commit by commit.
- **Peralta et al. "Why Are Agentic Pull Requests Merged or Rejected?" MSR '26. arXiv [2605.22534](https://arxiv.org/abs/2605.22534). [read]**
  - 11,048 closed agent PRs, 717 inspected by hand. Only 35.7% of rejections were clear agent failures; 31.2% were workflow constraints and 33.1% had no visible reason.
- **Nakashima, Ishimoto, Kondo, McIntosh, Kamei. "Why Agentic-PRs Get Rejected: A Comparative Study of Coding Agents." 2026. arXiv [2602.04226](https://arxiv.org/abs/2602.04226). [read]**
  - 654 rejected PRs. Seven rejection reasons occur only for agent PRs, including distrust of AI-generated code. 67.9% of rejections have no explicit feedback.
- **Ehsani et al. "Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests in GitHub." MSR '26. arXiv [2601.15195](https://arxiv.org/abs/2601.15195). [read]**
  - Docs, CI and build tasks merge most often; performance and bug fixes least. Unmerged PRs are larger and fail CI more often.
- **Watanabe et al. 2026, arXiv [2602.17084](https://arxiv.org/abs/2602.17084). [search]** Description style differs by agent and is associated with reviewer engagement and merge rate.
- **arXiv [2602.02345](https://arxiv.org/abs/2602.02345), 2026. [search]** Commit message quality by agent on AIDev-pop.
- **Abujadallah et al. "Understanding the Rejection of Fixes Generated by Agentic Pull Requests." 2026. arXiv 2606.13468. [search]** 46.4% of 3,225 agent fix PRs rejected.

## AI-written PR descriptions

- **Xiao, Hata, Treude, Matsumoto. "Generative AI for Pull Request Descriptions: Adoption, Impact, and Developer Interventions." FSE 2024. arXiv [2402.08967](https://arxiv.org/abs/2402.08967). [read]**
  - 18,256 PRs using Copilot for PRs, with propensity-score weighting.
  - Associated with an estimated 19.3h shorter review and 1.57× higher odds of merge.
  - Developers' edits to the AI text: deletion 22.9%, refinement 20.8%; additions were mostly template text, links, intent and testing information.
- **Liu, Xia, Treude, Lo, Li. "Automatic Generation of Pull Request Descriptions." ASE 2019. arXiv [1909.06987](https://arxiv.org/abs/1909.06987). [read]**
  - 333K PRs; a sequence-to-sequence model trained with reinforcement learning to maximize ROUGE.
  - A caution: optimizing an overlap metric directly is how such metrics get gamed.
- **arXiv [2505.01120](https://arxiv.org/abs/2505.01120), 2025. [search]** Data cleaning of 169K PR descriptions; noisy references distort scores.

## Commit message evaluation (methods carry over)

- **Tao et al. "On the Evaluation of Commit Message Generation Models: An Experimental Study." ICSME 2021. arXiv [2107.05373](https://arxiv.org/abs/2107.05373). [read]** BLEU variants across papers aren't comparable; dataset splitting changes results a lot. Introduces MCMD.
- **JetBrains Research. "Towards Realistic Evaluation of Commit Message Generation by Matching Online and Offline Settings." ICSE 2025 SEIP. arXiv [2410.12046](https://arxiv.org/abs/2410.12046). [search]** Uses how much users edit a generated message as the real-world signal; edit distance tracks it best, BLEU and METEOR poorly.
- **Zeng et al. "Evaluating Generated Commit Messages with Large Language Models." 2025. arXiv [2507.10906](https://arxiv.org/abs/2507.10906). [read]** LLM judges with reasoning and examples approach human-level evaluation and beat BLEU, ROUGE-L and METEOR.
- **Wu et al. "An Empirical Study on Commit Message Generation using LLMs via In-Context Learning." ICSE 2025. arXiv [2502.18904](https://arxiv.org/abs/2502.18904). [read]** Human ratings on informativeness, conciseness and expressiveness; BLEU disagrees with people partly because reference messages are poor.
- **Schall, Czinczoll, de Melo. "CommitBench." 2024. arXiv [2403.05188](https://arxiv.org/abs/2403.05188). [search]** 1.66M examples; dataset flaws can make weaker models score higher.
- **Eliseeva et al. "From Commit Message Generation to History-Aware Commit Message Completion." ASE 2023. arXiv [2308.07655](https://arxiv.org/abs/2308.07655). [search]** CommitChronicle, 10.7M commits.
- **Tian, Zhang, Treude et al. "What Makes a Good Commit Message?" ICSE 2022. [memory]** Good messages state what changed and why.

## What reviewers need from a PR

- **Pirouzkhah, Wurzel Gonçalves, Bacchelli. "The Value of Effective Pull Request Description." MSR '26. arXiv [2602.14611](https://arxiv.org/abs/2602.14611). [read]**
  - Eight description elements from writing guidelines, tested on 80K PRs plus a survey of 64 developers.
  - Purpose and code explanation are valued most; stating the kind of feedback wanted best predicts merge and reviewer engagement.
  - **To do:** get the full paper for the element list and effect sizes; it is the best source of rubric items.
- **Pascarella, Spadini, Palomba, Bruntink, Bacchelli. "Information Needs in Contemporary Code Review." CSCW 2018. [memory]** Reviewers need to know whether the change is suitable, why it was made, its context, how it was tested, and whether it should be split.
- **Bacchelli, Bird. "Expectations, Outcomes, and Challenges of Modern Code Review." ICSE 2013. [memory]** Understanding the change is reviewers' biggest challenge.
- **Gousios et al. "Work Practices and Challenges in Pull-Based Development: The Integrator's Perspective." ICSE 2015. [memory]** Integrators complain about poorly explained PRs.

## Benchmarks and datasets that don't fit, and why

| Source | What it measures | Gap for prbench |
|---|---|---|
| SWE-bench, Verified, Multimodal, Live [memory]; SWE-bench Pro ([Scale 2025](https://labs.scale.com/papers/swe-bench-pro)) [search]; SWE-Lancer, Multi-SWE-bench [memory] | Whether a patch passes hidden tests | Output is a bare diff; no PR text. Useful later as task inputs for end-to-end runs. |
| CodeReviewer (Microsoft 2022) [memory] | Review comment generation, scored with BLEU | Scores the reviewer, not the author's PR. |
| CRScore, Naik et al. NAACL 2025, [2409.19801](https://arxiv.org/abs/2409.19801) [search] | Review comments against claims drawn from the code, with no reference text | Scores review comments. **Its method (extract claims from the code, score text against them) is a model for prbench's accuracy check.** |
| SWR-Bench, Zeng et al. 2025, [2509.01494](https://arxiv.org/abs/2509.01494) [search] | 1,000 verified PRs; LLM checks review coverage against structured ground truth (about 90% agreement with people) | Scores reviews. **Its structured ground truth plus coverage check is a model for prbench's fact sheets.** |
| ContextCRBench [2511.07017](https://arxiv.org/abs/2511.07017), CodeReviewQA [2503.16167](https://arxiv.org/abs/2503.16167), CodeFuse-CR-Bench [2509.14856](https://arxiv.org/abs/2509.14856) [search] | Code review with context; review comprehension | Reviewer side only. |
| CommitBench, CommitChronicle, MCMD | Diff in, commit message out, against one reference | Single-turn, no sessions, no scoping, no claim checking. |

## Eval tooling considered

| Tool | Notes |
|---|---|
| Inspect AI (UK AISI) [search] | Good sandboxing and logs; model-graded scorers are pointwise, so pairwise judging is custom. |
| LangSmith [search] | Built-in pairwise comparison with optional order randomization; human annotation queues [memory]. Hosted. |
| DeepEval [search] | `ArenaGEval` pairwise with randomized, blinded positions. API changes between versions. |
| promptfoo [read] | `select-best` with fixed order; no position-bias handling. |
| Braintrust [memory] | Experiment comparison and human review UI. Not checked. |
| OpenAI Evals [search] | Hosted platform being retired in 2026; avoid. |

None computes judge–human agreement or handles paired statistics for us, and none sandboxes a replayed agent session. prbench writes JSON/JSONL so its results can be loaded into these tools later if useful.

## Judge reliability

- **Zheng et al. "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena." NeurIPS 2023. [memory]** Position, length and self-preference bias; judge each pair in both orders and treat disagreement as a tie.
- Pairwise comparison is more sensitive for "A vs. B"; pointwise rubric scores are easier to diagnose. prbench uses both.
- Bradley–Terry with bootstrapped confidence intervals for rankings of more than two systems; a sign test is enough for two.
- Calibrate against people with Cohen's kappa (two raters) or Krippendorff's alpha (several raters, ordinal scores), and measure human–human agreement as the ceiling.
