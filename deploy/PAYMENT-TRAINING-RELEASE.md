# 培训定价与付款审核联合更新

这是待执行的离线更新包。准备文件和本地测试不代表网站或数据库已经上线。

本次合并：五专科完整版 ¥1,580、整套课 ¥1,200、回放版停售；付款凭证原子提交；管理员确认实收金额后一次完成审核、权益和明确归属的报名；后台归属异常处理；「我的学习」按真实权益和报名显示。

## 包内文件

| 文件 | 用途 |
|---|---|
| `kidneysphere-payment-training.pyz` | 固定 29 个前端文件的检查、更新与回退 |
| `kidneysphere-payment-training.sql` | **唯一更新 SQL 入口**，定价和付款更新使用同一事务 |
| `kidneysphere-payment-training.inspect.sql` | 数据库发布前只读检查 |
| `kidneysphere-payment-training.rollback.sql` | 统一数据库回退入口 |
| `kidneysphere-payment-training.sources.json` | 固定 commit、文件范围和 SHA-256 |

如果文件名称包含版本号，请在下面的命令中使用包内 `.pyz` 的实际名称。

## 执行

1. 核对 `sources.json` 的 commit 和 SHA-256。将本包保存在网站目录之外，例如 `/root/`，不要上传到公开下载目录。
2. 在 Supabase SQL Editor 以数据库所有者身份运行 `.inspect.sql`。它只读商品、项目映射和数据库结构，不查询用户、订单或凭证记录。映射不明确或结构不满足时先核实，不根据项目标题、价格猜测归属。
3. **只运行一次合并后的 `.sql`**，不要再分别运行两份原始迁移。任一部分失败，整个事务都会撤销。脚本保存本次更新前的函数定义、所有者和权限，以及本次改动的商品字段和版本状态。
4. 在网站服务器运行只读检查：

```bash
python3 /root/kidneysphere-payment-training.pyz --check
```

检查仅接受以下完整前端基线之一，或所有文件均已是目标版本：

- 批量音频版：`4a3e70af6fecf9ec59daee4e731b464154ece573`。
- 上一轮价格版：`dca7f2c23d2d90358268b4df008f95f3f7063ecd`。

文件内容不明、混用基线、只更新了部分文件或符号链接都会阻断。检查还会读取公开匿名版本 RPC 和商品目录；必须同时确认 `payment-enrollment-20260914-v1` / `training-prices-20260914-v1` 已应用，且 15 条商品、5 条项目费用、停售 VIDEO 和旧价格版本符合要求。数据库未就绪或连接失败时，`--check` 返回退出码 2，`--apply` 不会写入。

5. 检查通过后更新前端：

```bash
python3 /root/kidneysphere-payment-training.pyz --apply
```

记录输出的 `BACKUP=` 路径和 `ROLLBACK_COMMAND`。备份在 `/root/kidneysphere-home-releases`，目录权限 `0700`、备份文件 `0600`；写入中途失败会自动恢复原文件。完整目标版本再次执行会报告 `NO_CHANGE`。

`.pyz` 不含 SQL，不执行数据库更新，不修改 Nginx，不重启服务。文件范围包含上一轮定价、后台审核和「我的学习」；首页、视频播放器、音频上传组件、后端和其他站点不在写入范围内。

## 上线验收

核查五专科定价和回放版停售；用对应测试账号核对凭证提交、管理员金额/凭证确认、审核后权益与明确归属报名、「我的学习」状态及异常提示。历史订单金额、已售权益时长和音频上传需要保持正确。公共只读检查不能代替登录后的业务验收。

## 回退

先用**同一个包**执行它输出的完整前端回退命令，例如：

```bash
python3 /root/kidneysphere-payment-training.pyz --rollback <本次BACKUP实际路径>
```

再按需在 Supabase SQL Editor 运行同包的 `.rollback.sql`。数据库回退先恢复付款函数和权限，再恢复本次首次应用的定价；**若价格版在本次联合更新前已经应用，它会保留该原有状态**。两部分在同一事务内执行，冲突会中止，不覆盖上线后的新修改。

数据库回退保留历史订单、付款、权益和已完成报名；前端回退不会自动回退数据库。不要用旧 `training-pricing-rollback.sql` 代替联合回退，也不要删除私有备份表或以手工拼接文件绕过基线检查。
