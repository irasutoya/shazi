# 部署到 Cloudflare Pages

这个项目本地开发时使用 `server.mjs`、`data/friends.json` 和 `public/uploads`。Cloudflare Pages 上不能依赖本地文件持久写入，所以云端版本使用：

- Cloudflare Pages：托管 `public/` 静态页面
- Pages Functions：提供 `/api/*`
- D1：保存好友资料
- R2：保存上传图片

## 1. 创建 Cloudflare 资源

安装 Wrangler 并登录：

```bash
npm install -g wrangler
wrangler login
```

创建 D1 数据库：

```bash
wrangler d1 create shazi-wiki
```

把返回的 `database_id` 填入 `wrangler.toml`。

创建 R2 bucket：

```bash
wrangler r2 bucket create shazi-wiki-uploads
```

初始化 D1 表：

```bash
wrangler d1 execute shazi-wiki --file=./schema.sql
```

## 2. 设置后台账号密码

在 Cloudflare Pages 项目的环境变量中设置：

```text
ADMIN_USER=你的账号
ADMIN_PASSWORD=你的强密码
```

## 3. 部署

首次部署：

```bash
wrangler pages deploy public --project-name shazi-wiki
```

如果你通过 GitHub 连接 Cloudflare Pages：

- Build command 留空，或填 `npm run build`
- Build output directory 填 `public`
- 确保 `functions/`、`schema.sql`、`wrangler.toml` 都提交到仓库
- 在 Pages 项目设置里绑定 D1：`DB`
- 在 Pages 项目设置里绑定 R2：`UPLOADS`

## 4. 域名

在 Cloudflare Pages 项目里添加自定义域名：

```text
shazi.wiki
```

Cloudflare 会自动处理 DNS 和 HTTPS。

## 5. 迁移已有本地数据

本地 `data/friends.json` 不能直接被 Cloudflare 自动读取。可以手动在后台重新添加，也可以以后写一个导入脚本把 JSON 写入 D1。

## Vercel 说明

Vercel 也可以部署前端，但这个项目需要持久化资料和图片。Vercel 版本需要额外接入 Vercel Postgres/KV 和 Vercel Blob，改动会比 Cloudflare D1/R2 更分散。当前仓库已优先实现 Cloudflare Pages 部署版本。
