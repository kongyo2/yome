# yome

[![ci](https://github.com/kongyo2/yome/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/yome/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kongyo2/yome.svg)](https://www.npmjs.com/package/@kongyo2/yome)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`yome` は [k1LoW/mo](https://github.com/k1LoW/mo) の Node.js 移植版です。`.md` ファイルをブラウザで開き、保存と同時にライブリロードして表示する Markdown ビューアです。

オリジナルの Go 実装の挙動を尊重しつつ、npm から `npx` で気軽に呼び出せるよう Node.js + React で書き直しています。

## 特徴

- **ライブリロード**: ファイルを保存するとブラウザが即座に再レンダリング
- **単一サーバー方式**: 既定ポート `6275` を共有し、後続の `yome` 呼び出しは既存セッションにファイルを追加する
- **グループ (タブ)**: `--target` で名前付きグループに分け、URL とサイドバーを分離
- **Watch モード**: ディレクトリや glob パターンを監視し、新規ファイルも自動で取り込む
- **stdin 入力**: パイプから渡した Markdown もその場でレンダリング
- **セッション復元**: サーバー停止後も次回起動時に開いていたファイルを自動で復元
- **リッチなレンダリング**:
  - GitHub Flavored Markdown
  - [Mermaid](https://mermaid.js.org/) 図 (フローチャート、シーケンス、ガント、Git グラフなど)
  - [KaTeX](https://katex.org/) 数式
  - [Shiki](https://shiki.style/) によるシンタックスハイライト
  - GitHub Alerts (`> [!NOTE]` など)
  - フロントマター対応

## 必要要件

- Node.js `>= 20.10.0`

## インストール

```bash
# グローバルインストール
npm install -g @kongyo2/yome

# あるいは都度実行
npx @kongyo2/yome README.md
```

## 使い方

```bash
# 単一ファイルを開く
yome README.md

# 複数ファイルと glob
yome README.md CHANGELOG.md docs/*.md

# 名前付きグループで開く (URL 例: http://localhost:6275/design)
yome spec.md --target design

# ポート変更
yome draft.md --port 6276

# stdin から読む
cat notes.md | yome
some-command | yome --target output

# ディレクトリを再帰的に watch
yome -w -R docs/
```

### サーバー操作

```bash
yome --status              # 起動中の yome サーバー一覧を表示 (orphan backup も検出)
yome --shutdown            # 起動中の yome サーバーをすべて停止 (--port 指定時はそのポートのみ)
yome --restart             # 状態を保ったまま再起動 (--port 指定時はそのポートのみ)
yome --clear               # 保存済みセッションを破棄 (確認プロンプトあり)
yome --clear --yes         # スクリプト / CI から非対話で破棄 (-y でも可)
yome --close path/to.md    # 指定ファイルだけグループから外す
yome --unwatch docs/       # watch パターンを解除

# 単発の ad-hoc プレビュー (前回 session を復元せず、今回の内容も backup に残さない)
yome SKILL.md --no-restore-session
```

> `--shutdown` は次回起動でセッションを復元できるよう backup を残します。本当に忘れさせたい場合は `--clear` を使ってください。`--status` は backup だけが残っている (log は消えている) port を `(saved session backup only)` と表示します。

### 主なオプション

| オプション                          | 説明                                            |
| ----------------------------------- | ----------------------------------------------- |
| `-t, --target <name>`               | グループ名 (既定: `default`)                    |
| `-p, --port <number>`               | ポート番号 (既定: `6275`)                       |
| `-b, --bind <addr>`                 | バインドアドレス (既定: `localhost`)            |
| `-w, --watch`                       | ディレクトリ / glob を watch パターンとして登録 |
| `-R, --recursive`                   | サブディレクトリも再帰的に対象にする            |
| `--open` / `--no-open`              | ブラウザの自動オープン制御                      |
| `--no-restore-session`              | port のセッション backup を読み書きしない       |
| `--foreground`                      | サーバーをフォアグラウンドで動かす              |
| `--json`                            | 出力を JSON 形式で標準出力に流す                |
| `-y, --yes`                         | 確認プロンプトを自動 yes (`--clear` など)       |
| `--dangerously-allow-remote-access` | 非ループバックバインド時の警告を抑止            |

`yome --help` で全オプションが確認できます。

## ライセンス

MIT License。

- オリジナル Go 実装 © [k1LoW](https://github.com/k1LoW) — <https://github.com/k1LoW/mo>
- Node.js 移植版 © kongyo2

詳細は [`LICENSE`](LICENSE) を参照してください。
