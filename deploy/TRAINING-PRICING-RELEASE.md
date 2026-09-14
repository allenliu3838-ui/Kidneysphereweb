# 培训项目统一价格发布说明

本次交付包含前端离线发布包和独立数据库脚本。**生成文件、通过本地测试或下载发布包，都不代表网站已经上线。** 正式上线需要依次完成数据库更新、阿里云前端发布和页面检查。

## 1. 本次价格口径

| 商品 | 统一价格 | 本次处理 |
| --- | ---: | --- |
| 培训报名完整版（`REG-FULL`） | ¥1,580 | 更新商品及学习项目报名费 |
| 专科整套视频课程（`BUNDLE`） | ¥1,200 | 更新整套课价格 |
| 原单独视频回放版（`REG-VIDEO`） | 停售 | 关闭新购买入口，保留历史商品记录 |

范围为肾小球病、重症肾内科、肾移植内科、肾脏病理和透析通路五个方向，代码前缀分别是 `GLOM`、`ICU`、`TX`、`PATHO`、`DA`。数据库映射明确列出15个商品和5个学习项目。

全部目标商品取消早鸟截止时间和划线价格；目标商品的活动价格版本改为过期。完整版和整套课沿用现有销售开关及招生状态，原先未开售的商品不会因改价自动开售。

历史订单、订单金额、付款凭证和已购权益保留；课程期限、项目关联和班期关联沿用原值。停售单独回放版不会撤销已购买用户的回放权限。本次也不实施新的自动分班或自动审核规则。

## 2. 交付文件

| 文件 | 用途 |
| --- | --- |
| `deploy/training-pricing-inspect.sql` | 只读核对数据库商品、项目和关联卡片 |
| `migration_20260914_training_prices.sql` | 数据库价格调整，并保存私有回滚备份 |
| `deploy/training-pricing-rollback.sql` | 单独恢复本次修改的数据库字段 |
| `kidneysphere-training-pricing-offline-20260914.pyz` | 阿里云前端文件检查、发布和回滚 |

SQL脚本在 Supabase SQL Editor 执行，不放进网站目录。前端包只发布下一节列出的文件，不含数据库更新脚本。

## 3. 前端发布的精确范围

目标目录固定为 `/var/www/kidneysphere`。允许的上一版本为提交 `4a3e70af6fecf9ec59daee4e731b464154ece573`，即已包含音频批量上传的版本。以下13个资源按依赖优先、页面随后顺序发布：

1. `training-commerce.js`（新增）
2. `academy.js`
3. `trainingprograms.js`
4. `checkout.js`
5. `learning-center.js`
6. `academy.html`
7. `checkout.html`
8. `learning.html`
9. `training-icu.html`
10. `training-tx.html`
11. `training-patho.html`
12. `training-glom.html`
13. `training-da.html`

只有新增的 `training-commerce.js` 允许原先不存在。其他文件必须匹配已知版本或本次版本；发现服务器上有其他修改时，发布会停止，避免覆盖。

本包不修改 Nginx、后端接口、登录模块、播放器或音频批量上传依赖，也不重启 Nginx、PM2 或其他服务。发布过程对相关已有文件记录并检查校验值。

## 4. 先更新 Supabase 数据库

打开 [KidneySphere 的 Supabase 项目](https://supabase.com/dashboard/project/eaatpwakhcjxjonlyfii)，确认项目编号为 `eaatpwakhcjxjonlyfii`，进入 SQL Editor。使用数据库所有者权限执行脚本。

建议先把 `deploy/training-pricing-inspect.sql` 的完整内容粘贴到一个新查询窗口并执行。这一步只读，不查询用户、订单或付款数据。

核对返回结果：

- `mapping_status` 为 `READY`，`issues` 为空。
- 列出15个目标商品和5个学习项目。
- 完整版目标价格为1580，整套课目标价格为1200，单独回放版目标销售状态为关闭。
- 招生状态、已有商品销售开关、课程期限和项目/班期关联符合现状。

如出现 `BLOCKED`、未映射商品或缺少项目，应根据结果修正明确映射后再执行，不能仅按项目名称猜测归属。

然后在 SQL Editor 执行 `migration_20260914_training_prices.sql` 的**完整内容**。脚本在一个数据库事务中检查、备份、修改并验证，遇到冲突会整体回滚。成功后可看到 `PRICING_APPLIED`；在已正确安装的数据库上重复执行会给出 `NO_CHANGE`。应确认整个查询执行成功，没有错误。

备份保存于数据库私有 schema `kidneysphere_release_private`，发布标识为 `training-prices-20260914-v1`。不得把该 schema 加入 PostgREST 的公开访问列表。无需把数据库密钥发到聊天或复制进前端包。

## 5. 再发布阿里云前端

将提供的 `.pyz` 文件上传到当前网站阿里云服务器的 `/root/` 目录。应使用构建完成时随包提供的真实 SHA-256 校验值；本说明不预填尚未生成的包校验值。

先在阿里云 Workbench 终端执行只读检查：

```bash
python3 /root/kidneysphere-training-pricing-offline-20260914.pyz --check
```

检查会验证网站目录、Nginx 目标配置、13个文件的版本及依赖。它还会读取已有 `assets/config.js` 中的公开匿名配置，向固定的 Supabase 项目发起只读 `GET` 请求，检查：

- 15个目标商品均存在，完整版1580元、整套课1200元。
- 5个单独回放版商品均已停售。
- 15个商品均没有旧划线价和早鸟截止时间。
- 5个学习项目报名费均为1580元。
- 目标商品没有仍处于活动状态的旧价格版本。

这些请求只查公开商品目录，不读取管理员密钥、用户、订单或付款信息，也不调用修改数据库的接口。

只有看到 `CATALOG_OK` 和 `CHECK_OK`（或所有文件已匹配的 `NO_CHANGE`）才继续。若提示 `CATALOG_NOT_READY`、`TRAINING_CATALOG_NOT_READY` 或 `PUBLIC_CATALOG_UNAVAILABLE`，应先检查 SQL 执行结果或服务器到 Supabase 的连接。`--apply` 会再次核对并阻止不符合条件的发布。

执行前端发布：

```bash
python3 /root/kidneysphere-training-pricing-offline-20260914.pyz --apply
```

程序会先在 `/root/kidneysphere-home-releases/` 下自动建立私有备份，再通过临时文件及原子替换发布。终端会打印本次真实的 `BACKUP=` 路径和完整 `ROLLBACK_COMMAND`。**请保留本次输出，回滚必须使用该次运行实际给出的备份目录。** 不要使用其他发布的备份路径。

看到 `RELEASE_OK`，表示13个本地资源校验值与受保护文件检查通过。发生发布错误时，程序会尝试从本次备份自动恢复；如果提示 `AUTOMATIC_ROLLBACK_INCOMPLETE`，应保留原终端输出和备份进行处理。

本包不重启服务，数据库也不会被这个命令再次修改。

## 6. 发布后核对

检查 [培训报名页](https://kidneysphere.com/academy.html?v=20260914_pricing1) 和五个培训详情页，确认只显示完整版1580元、专科整套课1200元，早鸟和单独回放版新购入口已移除。

在电脑和手机上各打开一次。核对报名按钮对应正确项目，结账金额与所选商品一致；已有订单应继续显示原订单金额。测试应避免提交真实测试付款。

使用已有付费账号核对已购课程仍可播放，并确认音频批量上传入口仍存在。登录后的课程播放需要真实账号验证，`RELEASE_OK` 不等于已完成全部用户流程测试。

## 7. 回滚

前端文件和数据库分别回滚。只恢复前端时，数据库会继续使用本次新价格；只恢复数据库时，前端也不会自动恢复旧页面。

需要完整撤回本次发布时，先执行阿里云终端在本次 `--apply` 成功备份后打印的完整 `ROLLBACK_COMMAND`，恢复前端文件。该命令使用同一个 `.pyz` 的 `--rollback` 操作以及本次真实备份路径，无须重启服务，也不依赖 Supabase 网络连接。

前端回滚会校验备份及现存文件。若文件已被后续修改、权限已改变或备份损坏，会停止并报告原因，不自动覆盖后续工作。

如需同时恢复数据库，在同一 Supabase 项目的 SQL Editor 执行 `deploy/training-pricing-rollback.sql` 的完整内容。它只恢复本次脚本实际修改的字段，订单、付款和已购权益仍保留。若相关字段已有后续修改，或者目标商品又启用了新的活动价格版本，会报 `PRICING_CONFLICT` 并停止整个回滚，先核对冲突再处理。

数据库回滚成功返回 `ROLLED_BACK`；已经恢复过的版本返回 `ALREADY_ROLLED_BACK`。保留前端与数据库各自的操作结果。

## 8. 构建和交付记录

开发者从最终不可变提交构建，命令格式为：

```text
python3 deploy/build-training-pricing-release.py --commit 完整40位提交SHA --output 发布包完整路径
```

构建输出包含真实提交、SHA-256、文件大小和13个文件列表。交付时应提供这些真实结果。正式状态以数据库执行结果、阿里云终端结果及线上检查为准，不能把本地包生成或预览成功写成“已上线”。
