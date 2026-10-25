# dsh-workspace-switch-cost — 工作区切换成本（DSH 插件）

> 换个项目不是免费的：重新读 AGENTS.md、重新注入 60+ 个技能的描述、重新摸清工具集。
> 这个插件量化「进一个工作区要烧多少上下文」，并建议哪些该常驻、哪些该归档。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-workspace-switch-cost
```

重启 DSH 后生效。**只读**。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `wsc_audit` | 量一个工作区的进入成本：冷启动四项开销、稳态值、几轮到达稳态 |
| `wsc_compare` | 横向对比多个工作区，并归因：哪个因素真的解释了成本差异 |
| `wsc_recommend` | 按「进入成本 × 访问频率」给出常驻 / 归档 / 观望的建议 |

## 冷启动的四个开销项

| 项 | 来源 |
|---|---|
| `agents-md` | 全局与项目 AGENTS.md 的注入 |
| `skill-catalog` | 每轮注入的技能目录（60+ 个技能就是 60+ 条描述） |
| `tools` | 工具 schema 的 JSON 定义 |
| `runtime-context` | 运行时快照 |

**稳态值**（steady state）是会话进入正常工作后的每轮注入量，**进入开销** = 冷启动 − 稳态。

## 归因的门槛

`wsc_compare` 的归因需要 **≥3 个工作区**才能算相关性。少于 3 个时它明确说「数据不够」而不是编一个结论——两个点之间永远能画出一条完美直线，那不是洞察。

同样，某个因素在所有工作区之间**没有差异**时，它被标注为「这是 profile 的属性，不是这个项目的属性」，不会当成发现卖给你。

## 设计取舍

- **用中位数不用均值**：一个 26000 事件的会话不该定义整个工作区的进入成本。
- **slug 从会话路径反推**：`<sessions>/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，所以显式给一个 `session` 时也能报出它属于哪个工作区，而不是 `slug: null`。
- **确定性**：全部为字符/token 计数与中位数，不调 LLM。

## 开发

```sh
node --test test/    # 38 个单测 + 21 项集成测试
```

## License

MIT
