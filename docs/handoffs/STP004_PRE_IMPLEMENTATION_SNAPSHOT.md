# STP 004 实施前文件快照（B08）

生成时间：2026-09-14 06:11:09 +08:00
工作目录：`D:\Program Files\PycharmProjects\studysteps`

## Git

- 分支：main
- HEAD：不存在（尚无 commit）
- origin：https://github.com/xyq-dev/studysteps.git
- 远端 refs：实施前需以当时 ls-remote 为准；本快照不伪造远端结果
- 处理：接受无 HEAD 开发；不 commit

## 排除项

- ``node_modules/``、``dist/``、``.git/``、``.vite/``、``coverage/``、``*.tsbuildinfo``：依赖或生成产物
- ``.env``：敏感本地配置（若存在）不复制正文、不写入哈希

## 文件清单与 SHA-256

| 路径 | 字节 | SHA-256 |
| --- | ---: | --- |
| `.env.example` | 339 | `c069de95afd3c8f6c767b54b9bfd26261ed811d43433a15f788bb1c71f8473d1` |
| `.github/workflows/ci.yml` | 815 | `2da762f84ae8e807bdaac143060929c6cee493df68f01a90491161dfa52cf7a9` |
| `.gitignore` | 158 | `8a6b8365532110e4b4713d67ab0be6d13c5d599b3856072763e722d0ad6b33c8` |
| `.node-version` | 3 | `f14b4987904bcb5814e4459a057ed4d20f58a633152288a761214dcd28780b56` |
| `.npmrc` | 60 | `440d43421cc8d4aaabed8f54dd0498ac0abc915963745d448db231653099258b` |
| `.nvmrc` | 3 | `f14b4987904bcb5814e4459a057ed4d20f58a633152288a761214dcd28780b56` |
| `.prettierignore` | 85 | `bd847f38da0be87faee624a5b792552778cf844d3bcf73684f2b23a28167c63e` |
| `AGENTS.md` | 6054 | `257b96cbb61c71c08a74537578fa726ea07a3d18ee776546ddc3b89aa06021bf` |
| `apps/admin/index.html` | 304 | `4a3511ab2e63810419d976715a089a1791cf3482e3b0d74b5117a97537aa87a1` |
| `apps/admin/package.json` | 707 | `0fd743c1803ac4bdcd0444bb336cfffbe8b90a62e458bcb326fed7e10d1c2830` |
| `apps/admin/src/app.test.tsx` | 544 | `a894c6875cb3fb0ad407e8ce338d4d0bb505ab039b7b4aeb213cd389fc23c6ef` |
| `apps/admin/src/app.tsx` | 299 | `1a57b33f64f3a2afafe7f0ec08f1c0540743ef1f2b2c05c83903f1503870e60e` |
| `apps/admin/src/main.tsx` | 320 | `2caf0c1cc3176cbf6e7849881e8448a34cc4aee0116d16492c3d9690006c4c91` |
| `apps/admin/src/styles.css` | 523 | `d3c841a71513551bb04a5e9d5b594fd2ab1e28cd0492791bcf4d252116aa8a71` |
| `apps/admin/tsconfig.json` | 489 | `226bf116ef7877f7d17ecb61c7117545f073af0632c3795a8c5b207e1fcd4fdf` |
| `apps/admin/vite.config.ts` | 500 | `b89e54eb0f644af638f7335ad3d2209a2f17dd8d5a51b3ab83957bc7191b0ae2` |
| `apps/admin/vitest.config.ts` | 573 | `45f499b2531752cd6cfbaafaf535726605347c52df976438a684cb393a127832` |
| `apps/api/Dockerfile` | 1324 | `096c07ce96936d583f2329503940e5ccc5ffd99d4aad38bebd56c164ecb172e3` |
| `apps/api/nest-cli.json` | 214 | `571f7760f530b8c09f5384fdb7c83799b49221ea595504c5cab4a4b0effab2c2` |
| `apps/api/package.json` | 816 | `8661c728f5a537250538ceb7ed6b84551abee779460100cb5a437cd7180458e7` |
| `apps/api/src/app.module.ts` | 163 | `990f975e501c3728d6d350c256dbf922997c5c0fe3a8c21f60a6ee9d70c556d2` |
| `apps/api/src/health/health.controller.spec.ts` | 1205 | `e6b8ecd3504ff179fc0813c0c74123c5fda01fbe7b9f302d9568068902588984` |
| `apps/api/src/health/health.controller.ts` | 317 | `5025a608d7c3a019af950b35a0e3bf300ba68e739c5ae4909b08302f8b5774d0` |
| `apps/api/src/health/health.module.ts` | 175 | `8e6fe50b38d87d28ed07af3285935f9496908c98eabd92c987b1b6d8def8d08b` |
| `apps/api/src/main.ts` | 284 | `77a7e386e7f961fcc701512534abc5150e243958b64c5784c5b606e097a6e353` |
| `apps/api/tsconfig.build.json` | 70 | `8148f695a2c5640113106270d18fbd7ff218109f4bfdd7626c030538f43c04af` |
| `apps/api/tsconfig.json` | 412 | `6ee7d6aefb313d7e44f0e3da9009654ed6b5bae8f057ea664551fc0fbf6291ff` |
| `apps/api/vitest.config.ts` | 496 | `9d1f7ada78d39d81dd17961fa7f4b0776bb756a88a355add4951107f20e7de40` |
| `apps/web/index.html` | 298 | `58d6f4698e612662df3abd1b2e72eb2bcc9dc50a3a1608c13fa4f22ff65761c8` |
| `apps/web/package.json` | 705 | `1d20c2e7d0d4d88da2bd58bbc698705e0dca6603439ce023eb2e62f660a889c9` |
| `apps/web/src/app.test.tsx` | 539 | `596d0bd6174e7ab131833756a593410c93f9d247206a32447f1e0538dd1d9b02` |
| `apps/web/src/app.tsx` | 290 | `f2f788aea37bc057e6b6bb29cdd52615cf9b322e5597303669c6f18be0cf29c7` |
| `apps/web/src/main.tsx` | 320 | `2caf0c1cc3176cbf6e7849881e8448a34cc4aee0116d16492c3d9690006c4c91` |
| `apps/web/src/styles.css` | 529 | `4a29760e013a4728a3502e993fae7cc1072800a8f4124a5d4447063755b5775d` |
| `apps/web/tsconfig.json` | 489 | `226bf116ef7877f7d17ecb61c7117545f073af0632c3795a8c5b207e1fcd4fdf` |
| `apps/web/vite.config.ts` | 500 | `0c49f57328324602cacdbea1d0ea2f26cc7d124e06313f24ebc8e2ae9d9d99b9` |
| `apps/web/vitest.config.ts` | 573 | `45f499b2531752cd6cfbaafaf535726605347c52df976438a684cb393a127832` |
| `docker-compose.yml` | 424 | `eef1af11da86f857554ae20323d1a19ddc6bd63847965bb4de78fcd4cd3f1511` |
| `docs/CURRENT_STATUS.md` | 10886 | `cfeecc7d7ff8aaad6cbcfa83338dd7aebb4540004c573cbbef6eb9e39d86391c` |
| `docs/CURSOR_PROMPTS.md` | 7238 | `54026bc416a842bb269e9ba369dc943755776c8cd7c8ec2fdf466cb8ad6075b4` |
| `docs/CURSOR_STP004_IMPLEMENT.md` | 21216 | `73a9d907adef782391aa2c1babcab8c809eefe1bfe0648788a01503165a23650` |
| `docs/CURSOR_STP004_PROMPT.md` | 12027 | `c93b0520a361971f6f23a1fa3e869a26e396289e422446bc36306436faf35e72` |
| `docs/PROJECT_PLAN.docx` | 71411 | `259af271f9ea1fe97f137c9c6162c694a39c05143757aae6acc2e8a18ab064e7` |
| `docs/PROJECT_PLAN.md` | 52643 | `0cda8935d67e6eaf03d2fcb1d9b477f9751ee2999cb6518cd52b0f20d3d9f2c2` |
| `docs/STP004_DESIGN.md` | 63898 | `8c8dea90b878a4f9f878d6c5543dc8ec6356e44af1aad8b6eb3975e7ad4b36e1` |
| `docs/TASKS.md` | 22504 | `2c906b20f6d682c97b94edb2408e3b398a4e43fb8c4b4474648bb7275adcad91` |
| `eslint.config.js` | 1084 | `00b3e3827917ae907e2c343e8e31fc17c11093b6b2ee1e133a285f85c5d25f1e` |
| `package.json` | 1246 | `64de4ba55510ee32709867019239a097ddcdbd93b2144807ce9f2f5a163caeb7` |
| `packages/contracts/package.json` | 559 | `64c8f0b7d79a8d3654f2cec63c9e8f86aa840b54adc16bd78c0e6e31ac45b714` |
| `packages/contracts/src/index.test.ts` | 492 | `3d8e4b97e85fee508e73cafb0e6beba953eb2ac10dcd97d36df4a5c0e8a5b1cb` |
| `packages/contracts/src/index.ts` | 270 | `14c1f4438a1bf744409d356736b796cd9722c8988d18c35a29e41ed002804e23` |
| `packages/contracts/tsconfig.json` | 184 | `d167f2a4bfbc98770bf0aa87c9db6b834b166eb44c11295db2e360a30a0dc7a3` |
| `packages/contracts/vitest.config.ts` | 131 | `9c51fd565cf6ad875bb6cf7d572b72ae2c14d2e156cf728f029e7ed72ea41227` |
| `packages/domain/package.json` | 556 | `d46dee40b44ef1bf51462c38608e9e03e4c209c13a489cef82d51a2fc5bcfa8b` |
| `packages/domain/src/index.test.ts` | 750 | `ba1d19e91752c6a96e0844f8718a773ece598ed234edda19caafccaba0c6a0e4` |
| `packages/domain/src/index.ts` | 182 | `245e9d549395995aa2c55545c0c907704b2d174af52bd5201f960d1c3b97110f` |
| `packages/domain/tsconfig.json` | 184 | `d167f2a4bfbc98770bf0aa87c9db6b834b166eb44c11295db2e360a30a0dc7a3` |
| `packages/domain/vitest.config.ts` | 131 | `9c51fd565cf6ad875bb6cf7d572b72ae2c14d2e156cf728f029e7ed72ea41227` |
| `packages/ui/package.json` | 709 | `361cbd70b9fde965530be556f6e4a8e6eb1e499fd8b32e522f00e9876dfad04a` |
| `packages/ui/src/index.ts` | 112 | `05ee88766507f5f8100e24e2ac7b5cd283bb3489bc8dd035132711004050c4f3` |
| `packages/ui/src/status-banner.test.tsx` | 537 | `e8a2a20e9d9be4b80816d23dc2942743266a231b74c46d8598b9e82d95eec14e` |
| `packages/ui/src/status-banner.tsx` | 163 | `0d166938084a3fa5dc0830f579ed9428551944795de01560fdc61fbd546cad6c` |
| `packages/ui/tsconfig.json` | 334 | `8e91c55593d3a79deede5d6543e3942c05330d01b5ba94a4e40b8d4ebb4e2d46` |
| `packages/ui/vitest.config.ts` | 178 | `96cd9e447db63e93f4e22cde31322de988e13e2a697b623880505e6cc9f97b80` |
| `pnpm-lock.yaml` | 183257 | `9c51b16dd49246ecdbd4489640d613415359bbea95f9b82c8e2957172f10888c` |
| `pnpm-workspace.yaml` | 128 | `355a2bb5bd5bd5afdf08ead2fafe5badfe9a4824d8aa6a4ffe93d068d5e97bde` |
| `prettier.config.mjs` | 130 | `36fa5bcc90b382b813118e9952f68f6e5489c82452cbeb41cb4a4dbc13f58fcc` |
| `prisma/schema.prisma` | 131 | `d6ba2e4d55dc9336acb9fece8e4ba1361aac8bdb4203aa06150c48035f67286a` |
| `README.md` | 3002 | `59add25b7126606507503932b506f575b16d32c5475662f2236d2c87283b4239` |
| `scripts/prisma-validate.mjs` | 360 | `9e74074a774c98c8231e752147fa9f6fe352f077c44ebfc132eed0f0d2b33b23` |
| `tsconfig.base.json` | 469 | `4e4d5697cac404a9d4877467d5ab253eac913489055bca6925a7d374fc660048` |

文件数：71
