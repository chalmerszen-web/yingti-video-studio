# 构建与运行

源码开发需 Windows、Node.js 24+、FFmpeg/FFprobe。执行 npm ci、npm run check、npm test；npm start 启动本机服务。正式构建按 scripts/build-windows.ps1 中的精确版本及 SHA 检查输入，不应为了构建通过而跳过校验。

## Windows 安装包

构建不是纯 npm 一键下载。当前脚本需要预先准备 .test-output/package-tools/，该缓存不公开上传。

- Node 24.12.0 x64，node-LICENSE.txt 与官方 node-SHASUMS256.txt；NodePath 可显式传入。
- FFmpeg/FFprobe 9.0 Gyan full build，保留原分发 LICENSE、README 与对应 ffmpeg-d32b387f2b.tar.gz 源归档；FfmpegPath 可显式传入。
- nsis-3.13/makensis.exe，或传 NsisPath；Windows .NET Framework64 v4.0.30319 csc.exe。
- electron-v44.6.0-win32-x64.zip 及 electron-44.6.0/ 解压目录，保留许可证。
- local-material-cpu-release/runtime/ 离线 Python、依赖及模型运行包，或传 LocalMaterialRuntime。锁定下载来源/哈希在 packaging/local-material-runtime.lock.json；准备程序为 packaging/prepare-local-runtime.py（先用 --help 查看参数），运行包说明在 packaging/LOCAL-MATERIAL-RUNTIME.txt。

工具与模型从各自官方来源获取；脚本/锁文件列出固定版本及哈希。不要上传个人虚拟环境、客户数据或凭据充当构建输入。固定旧版本若下架，需显式更新依赖与兼容测试，不宣称已有自动下载流程。

```powershell
node packaging/check-edition-versions.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Edition Developer -FastCompression
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Edition User -FastCompression
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/smoke-test.ps1 -Installer dist/YingTiStudio-Setup-2.2.9-win-x64.exe -Edition Developer
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/smoke-test.ps1 -Installer dist/YingTiStudioUser-Setup-2.3.6-win-x64.exe -Edition User
```

FastCompression 使用正式 zlib 压缩；QuickTest 是不压缩的测试候选，不作正式包。已有 stage 需要 Rebuild 时先核对路径。不要设置 YINGTI_MATERIAL_CASE，除非有另行授权的本地私有完整案例；该历史案例不在公开仓库。

双版元数据涉及 package.json/package-lock.json、packaging/user-edition.json、src/server.js、Launcher.cs、launcher.manifest、更新脚本及 HTML 版本标签。构建前检查会验证一致性。

安装数据位于各自 LocalAppData 的 YingTiStudio/data 或 YingTiStudioUser/data。测试使用隔离目录，不应覆盖真实用户项目。安装器保留数据，发布时仍需验证升级与卸载。安装包尚未使用发布者证书签名。

第三方运行时与模型许可证保持独立。打包脚本保留许可与来源说明；源码公开没有替代任何第三方再分发要求。
