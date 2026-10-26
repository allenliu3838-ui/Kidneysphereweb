# 论文数据包使用指南 · {{PROJECT_NAME}}
# Paper Pack Guide · {{PROJECT_NAME}}

> 导出时间 / Exported: {{EXPORT_DATE}}

---

## 这个文件夹是什么？

KidneySphere AI 已把你的研究数据**自动打包**好了。里面有：

- 去标识化的原始数据（CSV 表格）
- 一键分析脚本 → 自动生成 **Table 1、终点事件、eGFR斜率、KFRE评分**
- Methods 草稿（直接复制进论文，再由 PI 审改）

**你只需要跑一个脚本，剩下的全自动完成。**

---

## 第一步：安装 Python（只需做一次）

1. 下载并安装 **Anaconda**（免费）：https://www.anaconda.com/download
2. 安装完成后，打开 **Anaconda Prompt**（Windows）或 **Terminal**（Mac/Linux）

---

## 第二步：安装依赖库（只需做一次）

在终端里，`cd` 进入本文件夹，然后运行：

```bash
pip install -r analysis/requirements.txt
```

看到 `Successfully installed ...` 即可。

---

## 第三步：运行分析

### 单中心

```bash
python analysis/run_analysis.py
```

### 多中心（先合并，再分析）

**3a. 把各中心的 `data/` 文件夹整理成如下结构：**

```
centers/
  中心A/
    patients_baseline.csv
    visits_long.csv
    ...
  中心B/
    patients_baseline.csv
    visits_long.csv
    ...
```

**3b. 合并数据：**

```bash
python analysis/merge_centers.py
```

脚本会自动发现 `centers/` 下的所有子目录，合并后写入 `analysis/data/`，并生成 `merge_qc.xlsx`。

> ⚠️ **合并后先打开 `merge_qc.xlsx` 检查一遍**，确认没有重复记录或病人编号冲突，再进行下一步。

**3c. 运行分析：**

```bash
python analysis/run_analysis.py
```

运行结束后终端会打印 `✅ Done.` 并列出所有生成的文件。

---

## 第四步：找到你需要的文件

所有结果都在 `analysis/outputs/` 文件夹里：

| 文件 | 论文中的用途 |
|------|-------------|
| `table1_baseline.xlsx` | **直接用作 Table 1**（基线特征、药物、KFRE、终点） |
| `outcomes_12m.csv` | 12个月 eGFR / UPCR 变化，用于结果章节 |
| `kfre_scores.csv` | 每位患者的 KFRE 2年/5年肾衰竭风险（%）|
| `endpoints_egfr_decline.csv` | eGFR 下降 ≥40% / ≥57% 的首次达标日期 |
| `endpoints_igan_remission.csv` | IgAN 完全/部分缓解日期（IgAN 项目适用）|
| `egfr_slope_lme.csv` | eGFR 下降速率（LME 模型，整体队列）|
| `egfr_slope_per_patient.csv` | 每位患者个体 eGFR 斜率 |
| `plot_egfr_trend.png` | eGFR 趋势图 → 直接插入论文 Figure |
| `plot_upcr_trend.png` | UPCR 趋势图 → 直接插入论文 Figure |
| `plot_egfr_slope_hist.png` | eGFR 斜率分布直方图 → 补充图 |
| `qc_report.xlsx` | 数据质控报告（缺失率、重复、离群值）|

---

## 第五步：写论文

### Methods 草稿在哪里？

打开 `manuscript/METHODS_AUTO_EN.md`，里面已经写好了**可直接引用的 Methods 段落**，包括：

- 研究设计 & 数据来源
- eGFR 计算方法（CKD-EPI 2021）
- 多中心数据合并方法
- eGFR 终点定义（≥40% / ≥57% 下降）
- eGFR 斜率（线性混合效应模型）
- KFRE 公式 & 引用（Tangri et al. JAMA 2011）
- IgAN 缓解定义（CR / PR）
- 药物统计方法
- 统计分析平台

> **复制 → 粘贴进你的论文 → PI 审改 → 提交**

---

## 提交前必须检查（PI 清单）

在论文投稿前，请 PI 逐项确认：

- [ ] **KFRE 单位**：`kfre_scores.csv` 中的实验室值单位（白蛋白 g/dL、磷酸盐 mg/dL、钙 mg/dL）是否与你中心一致
- [ ] **UPCR vs uACR**：你的 UPCR 是否适合作为 KFRE 中 uACR 的替代指标
- [ ] **eGFR 终点确认**：`endpoints_egfr_decline.csv` 中的首次达标记录，需人工核实是否在 ≥2 次连续访视中持续
- [ ] **IgAN 缓解标准**：CR（UPCR < 300 mg/g）和 PR（≥50% 降幅且 < 1000 mg/g）的单位是否适用于本研究
- [ ] **多中心 QC**：`merge_qc.xlsx` 中无未解决的重复或碰撞记录
- [ ] **Methods 草稿**：`METHODS_AUTO_EN.md` 已由 PI 完整审阅并修改

---

## 常见问题

**Q: 运行脚本报错 `ModuleNotFoundError`？**
A: 重新运行 `pip install -r analysis/requirements.txt`，确保在正确的 conda 环境中。

**Q: `statsmodels` 未安装时 eGFR 斜率怎么办？**
A: 脚本会自动降级为个体 OLS 斜率（`egfr_slope_per_patient.csv`），LME 结果跳过。安装后重跑即可。

**Q: 8变量 KFRE 全部是空值？**
A: 说明 `labs_long.csv` 中未录入白蛋白/磷酸盐/碳酸氢根/钙。只用 4变量 KFRE 结果即可。

**Q: 多中心合并后患者数不对？**
A: 打开 `merge_qc.xlsx` → `PatientCollisions` 工作表，检查是否存在跨中心的 `patient_code` 重复。
