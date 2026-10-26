"""
KidneySphere AI — Multi-Center CSV Merge Utility (Phase 2)

Merges de-identified long-table CSVs from multiple centers into a single
analysis-ready dataset for run_analysis.py.

Usage
-----
  # Auto-discover center subdirectories under ./centers/
  python merge_centers.py

  # Explicit center data directories
  python merge_centers.py --dirs center_HK/data center_BJ/data center_SH/data

  # Custom output location
  python merge_centers.py --dirs c1/ c2/ --out merged_data/ --qc merge_qc.xlsx

What it does
------------
1. Loads all table CSVs from each center directory.
2. Validates required columns and center_code consistency.
3. Detects within-center duplicates (same patient + date row).
4. Warns about cross-center patient code collisions (unusual but not fatal).
5. Deduplicates: keeps first occurrence per unique key.
6. Concatenates all centers and writes merged CSVs to --out.
7. Writes a merge QC report (merge_qc.xlsx) with:
   - Center summary (N patients, N visits per center)
   - Duplicate records found and dropped
   - Cross-center patient code collisions
   - Missing file warnings

Output tables
-------------
  patients_baseline.csv   visits_long.csv   labs_long.csv
  meds_long.csv           variants_long.csv events_long.csv

Notes
-----
- The merge key across centers is (center_code, patient_code).
  Same patient_code in different centers is treated as different patients.
- Run run_analysis.py on the merged data/ folder after merging.
- PI must review merge_qc.xlsx for data integrity before analysis.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)

# ---------------------------
# Table definitions
# ---------------------------

TABLES: dict[str, dict] = {
    "patients_baseline": {
        "file":      "patients_baseline.csv",
        "required":  True,
        "dedup_key": ["center_code", "patient_code"],
        "req_cols":  ["center_code", "module", "patient_code"],
        "sort":      ["center_code", "patient_code"],
    },
    "visits_long": {
        "file":      "visits_long.csv",
        "required":  True,
        "dedup_key": ["center_code", "patient_code", "visit_date"],
        "req_cols":  ["center_code", "module", "patient_code", "visit_date"],
        "sort":      ["center_code", "patient_code", "visit_date"],
    },
    "labs_long": {
        "file":      "labs_long.csv",
        "required":  False,
        "dedup_key": ["center_code", "patient_code", "lab_date", "lab_name"],
        "req_cols":  ["center_code", "module", "patient_code"],
        "sort":      ["center_code", "patient_code", "lab_date"],
    },
    "meds_long": {
        "file":      "meds_long.csv",
        "required":  False,
        "dedup_key": ["center_code", "patient_code", "drug_name", "start_date"],
        "req_cols":  ["center_code", "module", "patient_code"],
        "sort":      ["center_code", "patient_code"],
    },
    "variants_long": {
        "file":      "variants_long.csv",
        "required":  False,
        "dedup_key": ["center_code", "patient_code", "gene", "variant"],
        "req_cols":  ["center_code", "module", "patient_code"],
        "sort":      ["center_code", "patient_code"],
    },
    "events_long": {
        "file":      "events_long.csv",
        "required":  False,
        "dedup_key": ["center_code", "patient_code", "event_type"],
        "req_cols":  ["center_code", "module", "patient_code"],
        "sort":      ["center_code", "patient_code", "event_date"],
    },
}

# ---------------------------
# Helpers
# ---------------------------

def pct(n: int, d: int) -> str:
    if d == 0:
        return "–"
    return f"{100.0 * n / d:.1f}%"

def load_csv(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path, encoding="utf-8-sig", low_memory=False)
        return df
    except Exception as e:
        print(f"  ⚠️  Failed to read {path}: {e}", file=sys.stderr)
        return None

def write_excel(path: Path, sheets: dict[str, pd.DataFrame]) -> None:
    with pd.ExcelWriter(path, engine="openpyxl") as w:
        for name, df in sheets.items():
            df.to_excel(w, index=False, sheet_name=name[:31])

def validate_center_df(
    df: pd.DataFrame,
    path: Path,
    req_cols: list[str],
    warnings_out: list[str],
) -> pd.DataFrame | None:
    for c in req_cols:
        if c not in df.columns:
            warnings_out.append(f"[SKIP] {path}: required column '{c}' missing — file excluded.")
            return None
    # Ensure center_code is populated
    if "center_code" in df.columns:
        blank = df["center_code"].isna() | (df["center_code"].astype(str).str.strip() == "")
        if blank.any():
            warnings_out.append(
                f"[WARN] {path}: {blank.sum()} rows have blank center_code — will be kept but flagged."
            )
    return df

# ---------------------------
# Core merge logic
# ---------------------------

def merge_all(
    center_dirs: list[Path],
    out_dir: Path,
    qc_path: Path,
    verbose: bool = True,
) -> dict[str, pd.DataFrame]:

    qc_warnings:        list[str]    = []
    qc_center_summary:  list[dict]   = []
    qc_duplicates:      list[dict]   = []
    qc_collisions:      list[dict]   = []

    # Collect raw frames per table per center
    raw: dict[str, list[pd.DataFrame]] = {t: [] for t in TABLES}

    if verbose:
        print(f"\n📂 Scanning {len(center_dirs)} center director{'ies' if len(center_dirs)!=1 else 'y'}...\n")

    for cdir in center_dirs:
        if not cdir.exists():
            qc_warnings.append(f"[SKIP] Directory not found: {cdir}")
            print(f"  ⚠️  Directory not found: {cdir}")
            continue

        if verbose:
            print(f"  📁 {cdir}")

        center_patients = 0
        center_visits   = 0

        for tname, tdef in TABLES.items():
            fpath = cdir / tdef["file"]
            df = load_csv(fpath)

            if df is None:
                if tdef["required"]:
                    qc_warnings.append(f"[WARN] {cdir}: required file '{tdef['file']}' not found.")
                    print(f"    ⚠️  Missing required: {tdef['file']}")
                else:
                    if verbose:
                        print(f"    –  Optional not present: {tdef['file']}")
                continue

            df = validate_center_df(df, fpath, tdef["req_cols"], qc_warnings)
            if df is None:
                continue

            if verbose:
                print(f"    ✓  {tdef['file']}: {len(df):,} rows")

            # Tag source directory
            df["_source_dir"] = str(cdir)
            raw[tname].append(df)

            if tname == "patients_baseline":
                center_patients = len(df)
            if tname == "visits_long":
                center_visits = len(df)

        # Derive center_code from patients file for summary
        cc_label = str(cdir)
        if raw["patients_baseline"]:
            last_patients = raw["patients_baseline"][-1]
            if "center_code" in last_patients.columns:
                ccs = last_patients["center_code"].dropna().unique().tolist()
                cc_label = ", ".join(str(c) for c in ccs) if ccs else str(cdir)

        qc_center_summary.append({
            "directory":    str(cdir),
            "center_code":  cc_label,
            "patients_n":   center_patients,
            "visits_n":     center_visits,
        })

    # ---------------------------
    # Concatenate, deduplicate, validate
    # ---------------------------

    merged: dict[str, pd.DataFrame] = {}

    print("\n🔗 Merging tables...\n")

    for tname, tdef in TABLES.items():
        frames = raw[tname]
        if not frames:
            if tdef["required"]:
                print(f"  ❌ {tname}: no data from any center — analysis will fail.")
            else:
                print(f"  –  {tname}: no data from any center (optional, skipped).")
            merged[tname] = pd.DataFrame()
            continue

        combined = pd.concat(frames, ignore_index=True)
        n_before  = len(combined)

        # Remove internal source tag
        combined = combined.drop(columns=["_source_dir"], errors="ignore")

        # Deduplicate
        key_cols = [c for c in tdef["dedup_key"] if c in combined.columns]
        if key_cols:
            dups = combined.duplicated(subset=key_cols, keep=False)
            if dups.any():
                dup_df = combined[dups].copy()
                dup_df["_table"] = tname
                for _, row in dup_df.drop_duplicates(subset=key_cols).iterrows():
                    rec = {"table": tname}
                    for k in key_cols:
                        rec[k] = row.get(k, "")
                    rec["duplicate_rows"] = int(dups.sum())
                    qc_duplicates.append(rec)

            combined = combined.drop_duplicates(subset=key_cols, keep="first")

        n_after = len(combined)

        # Sort
        sort_cols = [c for c in tdef["sort"] if c in combined.columns]
        if sort_cols:
            combined = combined.sort_values(sort_cols, na_position="last")

        if verbose:
            dropped = n_before - n_after
            drop_str = f" (dropped {dropped:,} dups)" if dropped else ""
            print(f"  ✓  {tname}: {n_after:,} rows{drop_str}")

        merged[tname] = combined

    # ---------------------------
    # Cross-center patient collision check
    # Same patient_code appearing in multiple center_codes → unusual but not fatal
    # ---------------------------

    if not merged["patients_baseline"].empty:
        pts = merged["patients_baseline"]
        if "center_code" in pts.columns and "patient_code" in pts.columns:
            pc_counts = (
                pts.groupby("patient_code")["center_code"]
                .nunique()
                .reset_index(name="n_centers")
            )
            collisions = pc_counts[pc_counts["n_centers"] > 1]
            if not collisions.empty:
                qc_warnings.append(
                    f"[WARN] {len(collisions)} patient_code(s) appear in >1 center_code — "
                    "confirm these are truly different patients."
                )
                print(
                    f"\n  ⚠️  {len(collisions)} patient_code collision(s) across centers "
                    "(same patient_code, different center_code). See merge_qc.xlsx."
                )
                for _, row in collisions.iterrows():
                    pc = row["patient_code"]
                    centers = pts[pts["patient_code"] == pc]["center_code"].unique().tolist()
                    qc_collisions.append({
                        "patient_code": pc,
                        "n_centers":    int(row["n_centers"]),
                        "center_codes": ", ".join(str(c) for c in centers),
                    })

    # ---------------------------
    # Write merged CSVs
    # ---------------------------

    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for tname, df in merged.items():
        if df.empty:
            continue
        fpath = out_dir / TABLES[tname]["file"]
        df.to_csv(fpath, index=False, encoding="utf-8-sig")
        written.append(TABLES[tname]["file"])

    print(f"\n💾 Written to {out_dir}/:")
    for f in written:
        print(f"   {f}")

    # ---------------------------
    # QC report
    # ---------------------------

    sheets: dict[str, pd.DataFrame] = {}

    sheets["CenterSummary"] = pd.DataFrame(qc_center_summary)

    if qc_warnings:
        sheets["Warnings"] = pd.DataFrame({"message": qc_warnings})

    if qc_duplicates:
        sheets["Duplicates"] = pd.DataFrame(qc_duplicates)
    else:
        sheets["Duplicates"] = pd.DataFrame({"status": ["No duplicates found"]})

    if qc_collisions:
        sheets["PatientCollisions"] = pd.DataFrame(qc_collisions)
    else:
        sheets["PatientCollisions"] = pd.DataFrame({"status": ["No cross-center patient_code collisions found"]})

    # Per-table row counts
    counts = [
        {"table": t, "rows_merged": len(df)} for t, df in merged.items()
    ]
    sheets["RowCounts"] = pd.DataFrame(counts)

    qc_path.parent.mkdir(parents=True, exist_ok=True)
    write_excel(qc_path, sheets)
    print(f"\n📊 QC report: {qc_path}")

    # ---------------------------
    # Final summary
    # ---------------------------

    n_pts = len(merged.get("patients_baseline", pd.DataFrame()))
    n_vis = len(merged.get("visits_long",       pd.DataFrame()))
    centers_n = 0
    if not merged.get("patients_baseline", pd.DataFrame()).empty:
        centers_n = merged["patients_baseline"]["center_code"].nunique()

    print(f"\n✅ Merge complete.")
    print(f"   Centers merged : {len(center_dirs)}")
    print(f"   center_code(s) : {centers_n}")
    print(f"   Patients       : {n_pts:,}")
    print(f"   Visits         : {n_vis:,}")
    if qc_warnings:
        print(f"   ⚠️  Warnings    : {len(qc_warnings)} — review {qc_path.name}")
    print(f"\n→  Run analysis:  python run_analysis.py\n")

    return merged


# ---------------------------
# Auto-discover centers
# ---------------------------

def discover_center_dirs(base: Path) -> list[Path]:
    """
    Auto-discover center directories under base/centers/ or base/ itself.
    A valid center directory contains at least patients_baseline.csv.
    """
    candidates: list[Path] = []
    for subdir in sorted(base.iterdir()):
        if subdir.is_dir() and (subdir / "patients_baseline.csv").exists():
            candidates.append(subdir)
    return candidates


# ---------------------------
# CLI entry point
# ---------------------------

def main():
    parser = argparse.ArgumentParser(
        description="KidneySphere AI — Multi-Center CSV Merge (Phase 2)",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--dirs", nargs="+", type=Path, default=None,
        help="Paths to center data directories (each must contain patients_baseline.csv).\n"
             "If not specified, auto-discovers subdirs of ./centers/ that contain patient CSVs.",
    )
    parser.add_argument(
        "--centers-root", type=Path, default=None,
        help="Root folder to auto-discover center subdirectories (default: ./centers/).",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("data"),
        help="Output directory for merged CSVs (default: ./data/).",
    )
    parser.add_argument(
        "--qc", type=Path, default=Path("merge_qc.xlsx"),
        help="Path for merge QC Excel report (default: ./merge_qc.xlsx).",
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Suppress verbose output.",
    )

    args = parser.parse_args()

    verbose = not args.quiet

    # Resolve center directories
    if args.dirs:
        center_dirs = [Path(d).resolve() for d in args.dirs]
    else:
        root = (args.centers_root or Path("centers")).resolve()
        if not root.exists():
            print(
                f"❌ No --dirs specified and auto-discover root '{root}' not found.\n"
                f"   Create a 'centers/' folder with one subfolder per center, each containing\n"
                f"   patients_baseline.csv, visits_long.csv, etc.\n"
                f"   Or use:  python merge_centers.py --dirs center1/ center2/ center3/",
                file=sys.stderr,
            )
            sys.exit(1)
        center_dirs = discover_center_dirs(root)
        if not center_dirs:
            print(
                f"❌ No valid center directories found in '{root}'.\n"
                f"   Each subdirectory must contain patients_baseline.csv.",
                file=sys.stderr,
            )
            sys.exit(1)
        if verbose:
            print(f"Auto-discovered {len(center_dirs)} center(s) under {root}:")
            for d in center_dirs:
                print(f"  {d}")

    merge_all(
        center_dirs=center_dirs,
        out_dir=args.out.resolve(),
        qc_path=args.qc.resolve(),
        verbose=verbose,
    )


if __name__ == "__main__":
    main()
