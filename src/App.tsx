import { KeyboardEvent, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Separator,
  Text,
  TextArea,
  TextField,
  Theme,
} from "@radix-ui/themes";
import { useSettings } from "./useSettings";
import { AppSettings } from "./types";
import { buildAzureChatCompletionsUrl } from "./azureOpenaiEndpoint";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function toShortcutMainKey(event: KeyboardEvent<HTMLInputElement>): string | null {
  if (event.code === "Space" || event.key === " ") return "Space";
  if (event.code.startsWith("Key")) return event.code.slice(3).toUpperCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key.toUpperCase();

  const keyMap: Record<string, string> = {
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };

  return keyMap[event.key] ?? null;
}

export default function App() {
  const { settings, saveSettings } = useSettings();
  const [form, setForm] = useState<AppSettings>(settings);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
  const [isCapturingShortcut, setIsCapturingShortcut] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");

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

  return (
    <Theme appearance="light" accentColor="cyan" grayColor="sand" radius="large" scaling="100%">
      <div className="settings-shell">
        <Card className="settings-card" size="4">
          <Flex direction="column" gap="4">
            <Flex align="center" justify="between">
              <Heading size="6">FreeVoice 設定</Heading>
              <Badge variant="soft" color="cyan">
                Push-to-Talk
              </Badge>
            </Flex>

            <Separator size="4" />

            <div className="settings-grid">
              <Flex className="settings-column" direction="column" gap="4">
                <Box>
                  <Text as="label" className="field-label" htmlFor="shortcut">
                    ショートカットキー
                  </Text>
                  <TextField.Root
                    id="shortcut"
                    value={form.shortcut}
                    readOnly
                    onFocus={() => {
                      setIsCapturingShortcut(true);
                      setShortcutHint("待機中: 押したキーの組み合わせを登録します（Escでキャンセル）。");
                    }}
                    onBlur={() => setIsCapturingShortcut(false)}
                    onKeyDown={handleShortcutKeyDown}
                    placeholder="クリックしてからショートカットを押す"
                  />
                  <Text size="1" color={isCapturingShortcut ? "cyan" : "gray"} mt="1">
                    {shortcutHint || "この欄をクリック後にキーを押すと自動登録されます。Backspace でクリアできます。"}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" className="field-label" htmlFor="endpoint">
                    Microsoft Foundry エンドポイント
                  </Text>
                  <TextField.Root
                    id="endpoint"
                    value={form.endpoint}
                    onChange={(e) => handleChange("endpoint", e.target.value)}
                    placeholder="https://your-resource.services.ai.azure.com"
                  />
                </Box>

                <Box>
                  <Text as="label" className="field-label" htmlFor="apiKey">
                    API Key
                  </Text>
                  <TextField.Root
                    id="apiKey"
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => handleChange("apiKey", e.target.value)}
                    placeholder="••••••••••••••••••••••••"
                  />
                </Box>

                <Flex gap="4">
                  <Box className="field-half">
                    <Text as="label" className="field-label" htmlFor="transcriptionModel">
                      文字起こしモデル
                    </Text>
                    <TextField.Root
                      id="transcriptionModel"
                      value={form.transcriptionModel}
                      onChange={(e) => handleChange("transcriptionModel", e.target.value)}
                      placeholder="gpt-4o-transcribe"
                    />
                  </Box>
                  <Box className="field-half">
                    <Text as="label" className="field-label" htmlFor="postprocessModel">
                      後処理モデル
                    </Text>
                    <TextField.Root
                      id="postprocessModel"
                      value={form.postprocessModel}
                      onChange={(e) => handleChange("postprocessModel", e.target.value)}
                      placeholder="gpt-5.2"
                    />
                  </Box>
                </Flex>

                {saveStatus === "saved" && (
                  <Callout.Root color="green" variant="soft" role="status">
                    <Callout.Text>保存しました</Callout.Text>
                  </Callout.Root>
                )}

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
              </Flex>

              <Flex className="settings-column settings-column-prompt" direction="column" gap="2">
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
              </Flex>
            </div>

            <Flex className="settings-actions" gap="3">
              <Button
                variant="soft"
                onClick={handleTest}
                disabled={testStatus === "testing" || !form.endpoint || !form.apiKey}
              >
                {testStatus === "testing" ? "テスト中..." : "接続テスト"}
              </Button>
              <Button onClick={handleSave}>保存</Button>
            </Flex>
          </Flex>
        </Card>
      </div>
    </Theme>
  );
}
