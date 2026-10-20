# mindmap-mcp

写真と同じデザインの**樹形図（マインドマップ）**を生成するMCPサーバです。
ダーク背景・ピンクの曲線コネクタ・角丸の選択枠を再現しています。

生成した図は **3日間だけ有効なURL** で公開され、そのURL上で **編集** できます。
編集は自動保存され、3日後にURLは無効化されデータは自動削除されます。

- **依存ゼロ**（`npm install` 不要・オフライン可）
- Node.js 18+ で動作

---

## 仕組み（HTTP専用）

MCPサーバ自身が **Streamable HTTP トランスポート**（`POST /mcp`）で動き、
同じプロセスが3日URLの編集画面も配信します。**stdioは使いません。**
常駐プロセスが1本あればMCPもURLも生き続けます。

```
node server.js      # http://<host>/mcp  と  編集URL  を同時に提供
```

1. MCPツール `create_mindmap` を呼ぶと、図がディスクに保存されURLが返ります。
2. 同じサーバがそのURLで編集画面を配信します。
3. `createdAt + 3日` を過ぎたURLは 404 になり、ファイルは自動削除されます。

エンドポイント:
- MCP: `http://localhost:4387/mcp`
- 編集URL: `http://localhost:4387/e/<token>`

---

## 起動

```
node server.js
```

このプロセスを起動したままにしてください（3日URLはこのサーバが生きている間だけ有効）。
常駐させるなら pm2 / systemd / Docker などでデーモン化します。例:

```
pm2 start server.js --name mindmap-mcp
```

## MCPクライアントへの登録（HTTPトランスポート）

Claude Code の場合、このURLをHTTP MCPとして登録します。

```
claude mcp add --transport http mindmap http://localhost:4387/mcp
```

Claude Desktop / その他クライアントの設定ファイルでは:

```json
{
  "mcpServers": {
    "mindmap": {
      "type": "http",
      "url": "http://localhost:4387/mcp"
    }
  }
}
```

> サーバはCORSを許可済みなので、ブラウザ系MCPクライアントからも `/mcp` に接続できます。

### 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `MINDMAP_PORT` | `4387` | HTTPサーバのポート |
| `MINDMAP_BASE_URL` | `http://localhost:<PORT>` | 返すURLのベース。外部公開時はここを公開ドメインに |
| `MINDMAP_DATA_DIR` | `./data` | 図の保存先 |

---

## ツール

### `create_mindmap`
樹形図を作成し、編集可能なURL（3日有効）を返します。

```jsonc
{
  "title": "EC2構成の検証環境を構築",
  "root": {
    "text": "EC2構成の検証環境を構築",
    "children": [
      "最初に手応えを感じたタスク",
      { "text": "CircleCIによるCI/CDパイプラインも整備" },
      { "text": "横展開", "children": ["他プロダクトの構成を流用"] }
    ]
  }
}
```

- ノードは `{ text, children? }` のネスト。文字列を直接書いてもOK。
- `root` の代わりに `tree`（トップレベル枝の配列）でも可。

返り値（`structuredContent`）: `{ url, token, expiresAt, expiresAtISO }`

### `get_mindmap_url`
既存トークンのURLと残り有効時間を返します（期限切れなら無効と報告）。

---

## 編集画面の操作

| 操作 | 内容 |
|---|---|
| ダブルクリック | ノードのテキストを編集 |
| Tab | 選択ノードに子を追加 |
| Enter | 選択ノードに兄弟を追加 |
| Delete / Backspace | 選択ノードを削除（ルート以外） |
| ○（ピンクの丸） | 枝の開閉 |
| ＋ボタン | 子ノードを追加 |
| 背景ドラッグ | 画面移動 |
| ホイール | 拡大 / 縮小 |

編集内容・表示位置は自動保存されます（期限は延長されません）。
