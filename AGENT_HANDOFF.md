# Agent 接手提示词

将下列提示词完整发送给接手 Agent，随后补充本次具体需求：

```text
你正在接手“映替 · 视频工作台”公开源码。先读取 AGENTS.md、README.md、docs/BUILD.md、docs/VALIDATION.md，并检查 package.json、packaging/user-edition.json 和 git status。先报告确认到的状态及剩余工作，再开始修改，不从头重写项目。

基线为开发版 2.2.9 / 用户版 2.3.6，Windows 本地 Node/Express/SQLite + 原生 JS 界面 + Electron/NSIS；Python CPU worker 负责本地材质修复。此快照不包含客户数据、真实密钥、模型权重或本机测试输出。

只由主智能体单独串行执行，不新建或唤醒子智能体。每次完成一项具体修改/实验，核对结果再进入下一步。进度保存到项目内；确实阻塞时报告具体条件，不通过无限等待假装运行。

必须保持：所有新分析/复核使用 Omni-Analysis；生成等待期限 3600 秒并持久化；主动中止/超时保留已完成片段供预览导出；稍后收取只复用原任务号；未知付费提交不能自动重发。余额预检由用户明确延期，等待平台提供新接口，当前默认不启用，禁止用无限 KEY 的占位额度当作账户钱包。

台词替换不能把旧对白重新混回；产品主体、包装盒、容器内产品和膏体分别约束。面霜涂抹必须验证真实接触、推开及终态，自动检测 PASS 不能代替连续画面检查。既有连续权重与指间残差修正不得随意回退。局部材质处理须保护手指、五官、原音和编辑范围外内容；人工标记不能自动伪造。

先跑适当测试建立现状。新增付费云端请求必须在用户授权的范围内；优先用模拟服务和合成媒体验证代码。修改后运行专项和完整回归；若本次要求安装包，再按双版元数据同步版本，分别构建并独立安装/启动/升级/数据保留验证。不要把历史 341 项通过当成本轮已跑，也不要把 FFmpeg 解码通过当作视觉效果验收。

禁止提交密钥、客户素材、数据库、原始回执、本机私人路径。提交前检查实际文件清单和差异，最终说明修改、证据、限制、产物地址和未完成事项。
```

## 关键代码入口

| 工作 | 入口 |
| --- | --- |
| 模型 ID、请求与信号 | src/provider.js |
| 分析及边界校正 | src/analysis.js、src/analysis-json.js |
| 队列、3600 秒、中止与收取 | src/engine.js |
| 部分结果导出 | src/partial-export.js、public/output-recovery.js |
| 台词、音轨及字幕 | src/full-dialogue.js、src/narration.js、src/media.js |
| 原片/成片检查 | src/quality.js、src/reconstruction.js |
| 本地材质与连续权重 | src/local-material.js、worker/local_material/ |
| 延期的余额原型 | src/funding.js、public/funding-ui.js、test/funding.test.js |
| HTTP 与用户数据边界 | src/server.js、src/store.js、src/keys.js |

## 接续优先级

没有隐含的新生成任务。先处理用户此次提出的具体需求。未来余额接入须取得真实余额口径、单价/币种、额度与钱包区别、失效策略，再补模拟合同测试及明确的只读验证。不要重新运行旧客户视频或猜测新平台接口。
