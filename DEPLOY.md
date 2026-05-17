# LPR matGPR 公网静态部署

## 最简单：Netlify 手动上传

1. 在本项目目录运行 `npm run build`。
2. 把 `dist` 文件夹上传到 Netlify 的 Deploys 页面。
3. Netlify 会生成公网网址，别人直接访问即可。

## Vercel

1. 把整个 `lpr-matgpr` 项目上传到 GitHub。
2. 在 Vercel 导入该仓库。
3. Vercel 会读取 `vercel.json`，执行 `npm run build`，发布 `dist`。

## GitHub Pages

1. 把整个 `lpr-matgpr` 项目推送到 GitHub 仓库的 `main` 分支。
2. 在仓库 Settings -> Pages 中选择 GitHub Actions。
3. `.github/workflows/deploy-pages.yml` 会自动构建并部署 `dist`。

## 传统服务器

把 `dist` 文件夹里的全部内容上传到服务器网站根目录即可，入口是 `index.html`。

## 注意

- 这是纯静态前端，不需要后端服务器。
- `.2B` 数据在浏览器本地解析，不会上传到服务器。
- 如果部署到子路径，保持 `index.html` 和 `src` 目录相对位置不变。
