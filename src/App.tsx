import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./useSettings";
import { AppSettings } from "./types";
import { buildAzureChatCompletionsUrl } from "./azureOpenaiEndpoint";

export default function App() {
  const { settings, saveSettings } = useSettings();
  const [form, setForm] = useState<AppSettings>(settings);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  const handleChange = (field: keyof AppSettings, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    saveSettings(form);
    try {
      await invoke("update_shortcut", { shortcut: form.shortcut });
    } catch (e) {
      console.error("ショートカット更新失敗:", e);
    }
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  };

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMessage("");
    try {
      const url = buildAzureChatCompletionsUrl(form.endpoint, form.postprocessModel);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": form.apiKey,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          reasoning_effort: "none",
        }),
      });
      if (res.ok || res.status === 400) {
        setTestStatus("ok");
        setTestMessage("接続成功");
      } else {
        const text = await res.text().catch(() => res.statusText);
        setTestStatus("error");
        setTestMessage(`エラー: ${res.status} ${text.slice(0, 120)}`);
      }
    } catch (e) {
      setTestStatus("error");
      setTestMessage(`接続失敗: ${String(e)}`);
    }
  };

  return (
    <div className="settings-container">
      <h1>FreeVoice 設定</h1>

      <div className="form-group">
        <label>ショートカットキー</label>
        <input
          value={form.shortcut}
          onChange={(e) => handleChange("shortcut", e.target.value)}
          placeholder="Ctrl+Shift+Space"
        />
      </div>

      <div className="form-group">
        <label>Microsoft Foundry エンドポイント</label>
        <input
          value={form.endpoint}
          onChange={(e) => handleChange("endpoint", e.target.value)}
          placeholder="https://your-resource.services.ai.azure.com"
        />
      </div>

      <div className="form-group">
        <label>API Key</label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => handleChange("apiKey", e.target.value)}
          placeholder="••••••••••••••••••••••••"
        />
      </div>

      <div className="form-group">
        <label>文字起こしモデル</label>
        <input
          value={form.transcriptionModel}
          onChange={(e) => handleChange("transcriptionModel", e.target.value)}
          placeholder="gpt-4o-transcribe"
        />
      </div>

      <div className="form-group">
        <label>後処理モデル（デプロイメント名）</label>
        <input
          value={form.postprocessModel}
          onChange={(e) => handleChange("postprocessModel", e.target.value)}
          placeholder="gpt-5.2"
        />
      </div>

      <div className="form-actions">
        <button
          className="btn-secondary"
          onClick={handleTest}
          disabled={testStatus === "testing" || !form.endpoint || !form.apiKey}
        >
          {testStatus === "testing" ? "テスト中..." : "接続テスト"}
        </button>
        <button className="btn-primary" onClick={handleSave}>
          保存
        </button>
      </div>

      {saveStatus === "saved" && (
        <div className="status-message success">保存しました</div>
      )}
      {testStatus === "ok" && (
        <div className="status-message success">{testMessage}</div>
      )}
      {testStatus === "error" && (
        <div className="status-message error">{testMessage}</div>
      )}
    </div>
  );
}
