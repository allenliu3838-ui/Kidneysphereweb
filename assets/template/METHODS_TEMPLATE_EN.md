# METHODS (AUTO DRAFT) — {{PROJECT_NAME}}

> Auto-generated draft. Principal investigator (PI) must review and edit before submission.
> eGFR decline thresholds and remission criteria should be confirmed against trial protocol.

## Study design
We conducted a multicenter observational registry study using de-identified follow-up data collected in KidneySphere AI.
The merge key for multicenter integration was `center_code + patient_code`.

## Cohort and data capture
- Disease module: {{MODULE}}
- Center code: {{CENTER_CODE}}
- Export date: {{EXPORT_DATE}}
- Number of patients: {{N_PATIENTS}}
- Number of follow-up visits: {{N_VISITS}}

The registry captured baseline characteristics and longitudinal follow-up visits. The minimal core follow-up items were visit date, blood pressure, serum creatinine, and proteinuria (UPCR).
Estimated glomerular filtration rate (eGFR) was calculated using the 2021 CKD-EPI creatinine equation (race-free), when age and sex were available.

## Pathology (IgA nephropathy)
For IgA nephropathy projects, Oxford MEST-C classification (M, E, S, T, C) was recorded from biopsy reports when available.

## Genetic data (if available)
If genetic testing was performed, variants were recorded in a long-table format including gene symbol, variant description, HGVS (c. and p. nomenclature), zygosity, and ACMG classification.

## Medications
Medication records were collected in a long-table format (meds_long) including drug name, drug class, dose, and start/end dates. Drug class frequencies were summarized in Table 1 as the number of patients (%) receiving each drug class at any point during the study period.

## Quality control
A standardized QC report was generated to assess missingness of core variables (visit date, systolic blood pressure, serum creatinine, UPCR), duplicated visits (same patient and date), and outlier values by center.

## Outcomes

### 12-month outcomes
A 12-month outcomes table was derived by selecting the visit closest to 12 months (within a prespecified window of 270–450 days) from baseline, and computing changes in eGFR and proteinuria (UPCR).

### eGFR decline endpoints
The composite kidney endpoint was defined as a sustained ≥40% decline in eGFR from baseline (corresponding to a 40% loss of kidney function; equivalent to a ~57% increase in serum creatinine) or a ≥57% decline (used in some KDIGO-aligned trials). Endpoint dates were determined as the first visit at which eGFR fell below the corresponding threshold relative to the individual patient's baseline eGFR. Investigators should verify sustained confirmation (≥2 consecutive qualifying visits) using the raw endpoints CSV (`endpoints_egfr_decline.csv`). Additional hard endpoints (ESRD onset, death) were recorded manually by clinical coordinators in the events registry (`events_long`).

### eGFR slope (rate of kidney function decline)
The rate of eGFR change over time was estimated using a linear mixed-effects model (LME), with time since baseline (years) as the fixed effect and a random intercept per patient (REML estimation). Individual patient slopes were also derived by ordinary least-squares (OLS) regression on each patient's eGFR–time trajectory. The LME-estimated slope represents the cohort-level mean eGFR change in mL/min/1.73m²/year.

### Remission endpoints (IgA nephropathy)
For patients enrolled under the IGAN module, remission was defined as follows:
- **Complete remission (CR):** UPCR < 300 mg/g (or equivalent in site-defined units) at any follow-up visit.
- **Partial remission (PR):** reduction in UPCR of ≥50% from baseline AND absolute UPCR < 1000 mg/g at any follow-up visit.

Time to first CR or PR was recorded. Investigators should confirm these definitions against the trial protocol and local unit conventions for UPCR.

## Multi-center data integration
Data from multiple centers were merged using the script `merge_centers.py`. The merge key was `center_code + patient_code`; the same `patient_code` appearing in different `center_code` values was treated as distinct patients. Within-center duplicate records (identical primary keys) were deduplicated by retaining the first occurrence. A merge QC report (`merge_qc.xlsx`) was generated documenting center-level row counts, duplicates dropped, and any cross-center patient code collisions. Investigators at each contributing center verified their own data exports before merging.

## Kidney Failure Risk Equation (KFRE)
The 2-year and 5-year predicted risk of kidney failure was estimated using the Kidney Failure Risk Equation (KFRE) published by Tangri et al. (JAMA 2011;305:1553–9, doi:10.1001/jama.2011.451).

**4-variable KFRE** was applied to all patients with available age, sex, eGFR, and proteinuria:

> LP = 0.2201 × (age/10 − 7.036) + 0.2467 × (female − 0.5642) − 0.5567 × (eGFR/5 − 7.222) + 0.4510 × (log₂(uACR) − 5.137)
> P(2-year) = 1 − 0.9832^exp(LP);  P(5-year) = 1 − 0.9365^exp(LP)

**8-variable KFRE** was additionally applied where serum albumin, phosphate, bicarbonate, and calcium values within 90 days of baseline were available from the laboratory table.

> ⚠ **PI review required for KFRE:** (1) UPCR (total protein-creatinine ratio) was used as a proxy for uACR (albumin-creatinine ratio) where uACR was unavailable; investigators must confirm whether this substitution is appropriate. (2) Coefficients are from the derivation cohort; regional re-calibration (e.g., Tangri 2016 JAMA IM) may be preferable. (3) Laboratory unit auto-conversion was applied heuristically (albumin g/L→g/dL if median >10; phosphate mmol/L→mg/dL if median <3; calcium mmol/L→mg/dL if median <5); verify against site lab conventions.

## Statistical analysis
Continuous variables are presented as mean ± SD or median (IQR). Categorical variables are presented as n (%). eGFR slope is expressed as mL/min/1.73m²/year (95% CI). KFRE is expressed as median (IQR) %. All analyses were performed using Python with pandas, NumPy, statsmodels, and matplotlib.

> **PI review required:** Auto-generated Methods sections are template drafts only. The PI must verify all endpoint definitions, statistical methods, and unit assumptions before manuscript submission. This system does not provide clinical decision support.
