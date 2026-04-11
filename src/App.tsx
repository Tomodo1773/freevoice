import { KeyboardEvent, useEffect, useState } from "react";
import appIcon from "../src-tauri/icons/128x128.png";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { setApiKey, setAzureFormatApiKey, setOpenaiFormatApiKey, setLangsmithApiKey, getAllApiKeys, migrateFormatApiKey } from "./apiKeyStore";
import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Select,
  Switch,
  Text,
  TextArea,
  TextField,
  Theme,
} from "@radix-ui/themes";
import History from "./History";
import { useSettings } from "./useSettings";
import { AppSettings, FormatProvider, InputMethod, LangsmithRegion, ReasoningEffort, TranscriptionProvider } from "./types";
import { buildFormatRequest } from "./postprocess";
import { logWarn, logError } from "./diagLog";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
const ENDPOINT_SAMPLE = "https://your-resource.services.ai.azure.com/api/projects/your-project";

const CODE_TO_KEY: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Escape: "Esc",
};

function toShortcutMainKey(event: KeyboardEvent<HTMLInputElement>): string | null {
  if (event.code.startsWith("Key")) return event.code.slice(3).toUpperCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(event.code)) return event.code;
  return CODE_TO_KEY[event.code] ?? null;
}

export default function App() {
  const { settings, saveSettings } = useSettings();
  const [form, setForm] = useState<AppSettings>(settings);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [azureFormatApiKeyInput, setAzureFormatApiKeyInput] = useState("");
  const [openaiFormatApiKeyInput, setOpenaiFormatApiKeyInput] = useState("");
  const [langsmithApiKeyInput, setLangsmithApiKeyInput] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
  const [isCapturingShortcut, setIsCapturingShortcut] = useState(false);
  const [isManualInput, setIsManualInput] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [page, setPage] = useState<"basic" | "model" | "prompt" | "history">("basic");
  const [version, setVersion] = useState("");
  const [defaultLogDir, setDefaultLogDir] = useState("");

  useEffect(() => {
    migrateFormatApiKey().then(() => getAllApiKeys()).then(({ apiKey, azureFormatApiKey, openaiFormatApiKey, langsmithApiKey }) => {
      if (apiKey) setApiKeyInput(apiKey);
      if (azureFormatApiKey) setAzureFormatApiKeyInput(azureFormatApiKey);
      if (openaiFormatApiKey) setOpenaiFormatApiKeyInput(openaiFormatApiKey);
      if (langsmithApiKey) setLangsmithApiKeyInput(langsmithApiKey);
    });
    isEnabled().then(setAutostartEnabled).catch((e) =>
      logWarn("app.init", "autostart isEnabled failed", { error: e })
    );
    getVersion().then(setVersion);
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
    }).catch((e) =>
      logWarn("app.init", "enumerateDevices failed", { error: e })
    );
    invoke<string>("get_app_log_dir").then(setDefaultLogDir).catch((e) =>
      logWarn("app.init", "get_app_log_dir failed", { error: e })
    );
  }, []);

  useEffect(() => {
    if (settings.shortcut !== "Ctrl+Shift+Space") {
      invoke("update_shortcut", { shortcut: settings.shortcut }).catch((e) =>
        logError("app.init", "shortcut sync failed", e)
      );
    }
  }, []);

  const handleChange = (field: keyof AppSettings, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    saveSettings(form);
    await setApiKey(apiKeyInput);
    await setAzureFormatApiKey(azureFormatApiKeyInput);
    await setOpenaiFormatApiKey(openaiFormatApiKeyInput);
    await setLangsmithApiKey(langsmithApiKeyInput);
    try {
      await invoke("update_shortcut", { shortcut: form.shortcut });
    } catch (e) {
      logError("app.updateShortcut", "update failed", e);
    }
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  };

  const isOpenai = form.formatProvider === "openai";
  const currentFormatApiKey = isOpenai ? openaiFormatApiKeyInput : azureFormatApiKeyInput;
  const currentFormatModel = isOpenai ? form.openaiFormatModel : form.azureFormatModel;

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMessage("");
    try {
      const { url, headers } = buildFormatRequest(form.formatProvider, form.formatEndpoint, currentFormatApiKey);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: currentFormatModel,
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

  const handleShortcutKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isCapturingShortcut) return;

    event.preventDefault();

    if (event.key === "Escape") {
      setIsCapturingShortcut(false);
      setShortcutHint("登録をキャンセルしました。");
      return;
    }

    if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      handleChange("shortcut", "");
      setIsCapturingShortcut(false);
      setShortcutHint("ショートカットをクリアしました。");
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) {
      setShortcutHint("修飾キーを押したまま、他のキーを押してください。");
      return;
    }

    const mainKey = toShortcutMainKey(event);
    if (!mainKey) {
      setShortcutHint("このキーは登録できません。別のキーを試してください。");
      return;
    }

    const parts: string[] = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");

    if (parts.length === 0) {
      setShortcutHint("修飾キー（Ctrl / Alt / Shift / Meta）を含めてください。");
      return;
    }

    const nextShortcut = [...parts, mainKey].join("+");
    handleChange("shortcut", nextShortcut);
    setIsCapturingShortcut(false);
    setShortcutHint(`登録候補: ${nextShortcut}`);
  };

  const navItems = [
    { key: "basic" as const, label: "基本設定" },
    { key: "model" as const, label: "モデル設定" },
    { key: "prompt" as const, label: "プロンプト" },
    { key: "history" as const, label: "履歴" },
  ];

  return (
    <Theme appearance="light" accentColor="cyan" grayColor="sand" radius="large" scaling="100%">
      <div className="settings-shell">
        <nav className="sidebar">
          <Flex align="center" gap="2" className="sidebar-header">
            <img src={appIcon} alt="FreeVoice" style={{ width: 24, height: 24 }} />
            <Heading size="4">FreeVoice</Heading>
          </Flex>
          {version && <Text size="1" color="gray">v{version}</Text>}
          <Flex direction="column" gap="1" className="sidebar-nav">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={`sidebar-item${page === item.key ? " active" : ""}`}
                onClick={() => setPage(item.key)}
              >
                {item.label}
              </button>
            ))}
          </Flex>
        </nav>

        <div className="main-content">
          {page === "basic" && (
            <Flex direction="column" gap="4">
              <Box>
                <Text as="label" className="field-label" htmlFor="shortcut">
                  ショートカットキー
                </Text>
                <TextField.Root
                  id="shortcut"
                  value={form.shortcut}
                  readOnly={!isManualInput}
                  onChange={isManualInput ? (e) => handleChange("shortcut", e.target.value) : undefined}
                  onFocus={() => {
                    if (!isManualInput) {
                      setIsCapturingShortcut(true);
                      setShortcutHint("待機中: 押したキーの組み合わせを登録します（Escでキャンセル）。");
                    }
                  }}
                  onBlur={() => {
                    setIsCapturingShortcut(false);
                    if (isManualInput) {
                      setIsManualInput(false);
                      setShortcutHint("");
                    }
                  }}
                  onKeyDown={!isManualInput ? handleShortcutKeyDown : undefined}
                  placeholder="クリックしてからショートカットを押す"
                >
                  <TextField.Slot side="right">
                    <Button
                      size="1"
                      variant="ghost"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const next = !isManualInput;
                        setIsManualInput(next);
                        setIsCapturingShortcut(false);
                        setShortcutHint(next ? "例: Meta+Space, Ctrl+Shift+A" : "");
                      }}
                    >
                      {isManualInput ? "完了" : "手動入力"}
                    </Button>
                  </TextField.Slot>
                </TextField.Root>
                <Text size="1" color={isCapturingShortcut ? "cyan" : "gray"} mt="1">
                  {shortcutHint || "この欄をクリック後にキーを押すと自動登録されます。Backspace でクリアできます。"}
                </Text>
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="logFolder">
                  ログ保存フォルダー
                </Text>
                <TextField.Root
                  id="logFolder"
                  value={form.logFolder}
                  onChange={(e) => handleChange("logFolder", e.target.value)}
                  placeholder="例: C:\Users\you\Documents\FreeVoiceLogs（空欄でデフォルト）"
                />
                <Text size="1" color="gray" mt="1" as="p">
                  空欄の場合、文字起こし結果のログも下記のアプリ既定フォルダに出力されます。
                </Text>
                {defaultLogDir && (
                  <Text size="1" color="gray" mt="1" as="p">
                    エラーログ・診断ログの出力先（設定に関わらず常時）: <code>{defaultLogDir}</code>
                  </Text>
                )}
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="audioDeviceId">
                  マイクデバイス
                </Text>
                <Select.Root
                  value={form.audioDeviceId || "__default__"}
                  onValueChange={(v) => handleChange("audioDeviceId", v === "__default__" ? "" : v)}
                >
                  <Select.Trigger id="audioDeviceId" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="__default__">デフォルト</Select.Item>
                    {audioDevices.map((d) => (
                      <Select.Item key={d.deviceId} value={d.deviceId}>
                        {d.label || `マイク (${d.deviceId.slice(0, 8)}...)`}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Text size="1" color="gray" mt="1" as="p">
                  システム音声が混入する場合は、使用するマイクを明示的に選択してください。
                </Text>
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="inputMethod">
                  入力方式
                </Text>
                <Select.Root
                  value={form.inputMethod}
                  onValueChange={(v) => handleChange("inputMethod", v as InputMethod)}
                >
                  <Select.Trigger id="inputMethod" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="clipboard">クリップボード（Ctrl+V）</Select.Item>
                    <Select.Item value="keystroke">キーストローク（直接入力）</Select.Item>
                  </Select.Content>
                </Select.Root>
                <Text size="1" color="gray" mt="1" as="p">
                  クリップボード: 安定だがターミナルで折りたたまれる場合あり。キーストローク: ターミナル向きだがアプリによっては不安定。
                </Text>
              </Box>

              <Box>
                <Text as="label" className="field-label">
                  スタートアップ
                </Text>
                <Flex align="center" gap="2">
                  <Switch
                    checked={autostartEnabled}
                    onCheckedChange={async (checked) => {
                      try {
                        if (checked) await enable(); else await disable();
                        setAutostartEnabled(checked);
                      } catch (e) {
                        logError("app.autostart", "set failed", e);
                      }
                    }}
                  />
                  <Text size="2" color="gray">Windows 起動時に自動起動する</Text>
                </Flex>
              </Box>

              {saveStatus === "saved" && (
                <Callout.Root color="green" variant="soft" role="status">
                  <Callout.Text>保存しました</Callout.Text>
                </Callout.Root>
              )}

              <Flex className="settings-actions" gap="3">
                <Button onClick={handleSave}>保存</Button>
              </Flex>
            </Flex>
          )}

          {page === "model" && (
            <Flex direction="column" gap="4">
              <Heading size="3">文字起こし</Heading>

              <Box>
                <Text as="label" className="field-label" htmlFor="transcriptionProvider">
                  プロバイダー
                </Text>
                <Select.Root
                  value={form.transcriptionProvider}
                  onValueChange={(v) => handleChange("transcriptionProvider", v as TranscriptionProvider)}
                >
                  <Select.Trigger id="transcriptionProvider" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="azure-openai">Microsoft Foundry (GPT-4o transcribe)</Select.Item>
                    <Select.Item value="azure-speech">Microsoft Foundry (Azure AI Speech)</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Box>

              {form.transcriptionProvider === "azure-openai" && (
                <Box>
                  <Text as="label" className="field-label" htmlFor="endpoint">
                    エンドポイント
                  </Text>
                  <TextField.Root
                    id="endpoint"
                    value={form.endpoint}
                    onChange={(e) => handleChange("endpoint", e.target.value)}
                    placeholder={ENDPOINT_SAMPLE}
                  />
                  <Text size="1" color="gray" mt="1" as="p">
                    Azure AI Foundry のプロジェクト URL。例: {ENDPOINT_SAMPLE}
                  </Text>
                </Box>
              )}

              {form.transcriptionProvider === "azure-speech" && (
                <Box>
                  <Text as="label" className="field-label" htmlFor="speechEndpoint">
                    Speech エンドポイント
                  </Text>
                  <TextField.Root
                    id="speechEndpoint"
                    value={form.speechEndpoint}
                    onChange={(e) => handleChange("speechEndpoint", e.target.value)}
                    placeholder="例: https://eastus2.stt.speech.microsoft.com"
                  />
                  <Text size="1" color="gray" mt="1" as="p">
                    Foundry プロジェクトのリージョンに合わせたエンドポイントを入力してください。
                  </Text>
                </Box>
              )}

              <Box>
                <Text as="label" className="field-label" htmlFor="apiKey">
                  API Key
                </Text>
                <TextField.Root
                  id="apiKey"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="APIキーを入力"
                />
              </Box>

              {form.transcriptionProvider === "azure-speech" && (
                <Box>
                  <Text as="label" className="field-label" htmlFor="speechLanguage">
                    言語
                  </Text>
                  <TextField.Root
                    id="speechLanguage"
                    value={form.speechLanguage}
                    onChange={(e) => handleChange("speechLanguage", e.target.value)}
                    placeholder="例: ja-JP"
                  />
                </Box>
              )}

              {form.transcriptionProvider === "azure-openai" && (
                <Box>
                  <Text as="label" className="field-label" htmlFor="transcriptionModel">
                    モデル
                  </Text>
                  <TextField.Root
                    id="transcriptionModel"
                    value={form.transcriptionModel}
                    onChange={(e) => handleChange("transcriptionModel", e.target.value)}
                    placeholder="gpt-4o-transcribe"
                  />
                </Box>
              )}

              <Heading size="3" mt="4">フォーマット</Heading>

              <Box>
                <Text as="label" className="field-label" htmlFor="formatProvider">
                  プロバイダー
                </Text>
                <Select.Root
                  value={form.formatProvider}
                  onValueChange={(v) => handleChange("formatProvider", v as FormatProvider)}
                >
                  <Select.Trigger id="formatProvider" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="azure">Azure</Select.Item>
                    <Select.Item value="openai">OpenAI</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Box>

              {form.formatProvider === "azure" && (
                <Box>
                  <Text as="label" className="field-label" htmlFor="formatEndpoint">
                    エンドポイント
                  </Text>
                  <TextField.Root
                    id="formatEndpoint"
                    value={form.formatEndpoint}
                    onChange={(e) => handleChange("formatEndpoint", e.target.value)}
                    placeholder="https://your-resource.openai.azure.com/"
                  />
                  <Text size="1" color="gray" mt="1" as="p">
                    Azure ポータルからコピーしたエンドポイントをそのまま貼り付けてください。
                  </Text>
                  <Text size="1" color="gray" as="p">
                    例: https://your-resource.openai.azure.com/
                  </Text>
                </Box>
              )}

              <Box>
                <Text as="label" className="field-label" htmlFor="formatApiKey">
                  API Key
                </Text>
                <TextField.Root
                  id="formatApiKey"
                  type="password"
                  value={isOpenai ? openaiFormatApiKeyInput : azureFormatApiKeyInput}
                  onChange={(e) => (isOpenai ? setOpenaiFormatApiKeyInput : setAzureFormatApiKeyInput)(e.target.value)}
                  placeholder={isOpenai ? "sk-..." : "APIキーを入力"}
                />
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="formatModel">
                  モデル
                </Text>
                <TextField.Root
                  id="formatModel"
                  value={isOpenai ? form.openaiFormatModel : form.azureFormatModel}
                  onChange={(e) => handleChange(isOpenai ? "openaiFormatModel" : "azureFormatModel", e.target.value)}
                  placeholder={isOpenai ? "gpt-4o" : "gpt-5.2"}
                />
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="reasoningEffort">
                  Reasoning Effort
                </Text>
                <Select.Root
                  value={form.reasoningEffort}
                  onValueChange={(v) => handleChange("reasoningEffort", v as ReasoningEffort)}
                >
                  <Select.Trigger id="reasoningEffort" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="none">none</Select.Item>
                    <Select.Item value="low">low</Select.Item>
                    <Select.Item value="medium">medium</Select.Item>
                    <Select.Item value="high">high</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Box>

              <Heading size="3" mt="4">LangSmith トレース</Heading>

              <Box>
                <Text as="label" className="field-label">
                  有効
                </Text>
                <Flex align="center" gap="2">
                  <Switch
                    checked={form.langsmithEnabled}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, langsmithEnabled: checked }))
                    }
                  />
                  <Text size="2" color="gray">
                    フォーマット呼び出しを LangSmith にトレース送信する
                  </Text>
                </Flex>
                <Text size="1" color="gray" mt="1" as="p">
                  API キーは <a href="https://smith.langchain.com/settings" target="_blank" rel="noreferrer">LangSmith Settings</a> から取得できます。
                </Text>
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="langsmithApiKey">
                  API Key
                </Text>
                <TextField.Root
                  id="langsmithApiKey"
                  type="password"
                  value={langsmithApiKeyInput}
                  onChange={(e) => setLangsmithApiKeyInput(e.target.value)}
                  placeholder="lsv2_..."
                />
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="langsmithProject">
                  Project
                </Text>
                <TextField.Root
                  id="langsmithProject"
                  value={form.langsmithProject}
                  onChange={(e) => handleChange("langsmithProject", e.target.value)}
                  placeholder="freevoice"
                />
              </Box>

              <Box>
                <Text as="label" className="field-label" htmlFor="langsmithRegion">
                  リージョン
                </Text>
                <Select.Root
                  value={form.langsmithRegion}
                  onValueChange={(v) =>
                    setForm((prev) => ({ ...prev, langsmithRegion: v as LangsmithRegion }))
                  }
                >
                  <Select.Trigger id="langsmithRegion" style={{ width: "100%" }} />
                  <Select.Content>
                    <Select.Item value="us">US (api.smith.langchain.com)</Select.Item>
                    <Select.Item value="eu">EU (eu.api.smith.langchain.com)</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Box>

              <Box>
                <Text as="label" className="field-label">
                  プロンプト・応答本文を含める
                </Text>
                <Flex align="center" gap="2">
                  <Switch
                    checked={form.langsmithIncludeContent}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, langsmithIncludeContent: checked }))
                    }
                  />
                  <Text size="2" color="gray">
                    文字起こしとフォーマット結果をトレースに含める（エバリュエーション用）
                  </Text>
                </Flex>
              </Box>

              {testStatus === "ok" && (
                <Callout.Root color="green" variant="soft" role="status">
                  <Callout.Text>{testMessage}</Callout.Text>
                </Callout.Root>
              )}

              {testStatus === "error" && (
                <Callout.Root color="red" variant="soft" role="alert">
                  <Callout.Text>{testMessage}</Callout.Text>
                </Callout.Root>
              )}

              {saveStatus === "saved" && (
                <Callout.Root color="green" variant="soft" role="status">
                  <Callout.Text>保存しました</Callout.Text>
                </Callout.Root>
              )}

              <Flex className="settings-actions" gap="3">
                <Button
                  variant="soft"
                  onClick={handleTest}
                  disabled={testStatus === "testing" || (form.formatProvider === "azure" && !form.formatEndpoint) || !currentFormatApiKey}
                >
                  {testStatus === "testing" ? "テスト中..." : "接続テスト"}
                </Button>
                <Button onClick={handleSave}>保存</Button>
              </Flex>
            </Flex>
          )}

          {page === "prompt" && (
            <Flex direction="column" gap="2" style={{ height: "100%" }}>
              <Text as="label" className="field-label" htmlFor="postprocessPrompt">
                フォーマット用プロンプト
              </Text>
              <TextArea
                className="prompt-textarea"
                id="postprocessPrompt"
                value={form.postprocessPrompt}
                onChange={(e) => handleChange("postprocessPrompt", e.target.value)}
                rows={18}
                placeholder="後処理時に system role として渡すプロンプト"
              />

              {saveStatus === "saved" && (
                <Callout.Root color="green" variant="soft" role="status">
                  <Callout.Text>保存しました</Callout.Text>
                </Callout.Root>
              )}

              <Flex className="settings-actions" gap="3">
                <Button onClick={handleSave}>保存</Button>
              </Flex>
            </Flex>
          )}

          {page === "history" && <History />}
        </div>
      </div>
    </Theme>
  );
}
