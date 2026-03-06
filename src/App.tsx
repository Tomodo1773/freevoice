import { useState } from "react";
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

            <Box>
              <Text as="label" className="field-label" htmlFor="shortcut">
                ショートカットキー
              </Text>
              <TextField.Root
                id="shortcut"
                value={form.shortcut}
                onChange={(e) => handleChange("shortcut", e.target.value)}
                placeholder="Ctrl+Shift+Space"
              />
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

            <Box>
              <Text as="label" className="field-label" htmlFor="postprocessPrompt">
                フォーマット用プロンプト
              </Text>
              <TextArea
                id="postprocessPrompt"
                value={form.postprocessPrompt}
                onChange={(e) => handleChange("postprocessPrompt", e.target.value)}
                rows={8}
                placeholder="後処理時に system role として渡すプロンプト"
              />
            </Box>

            <Flex gap="3" justify="end" mt="2">
              <Button
                variant="soft"
                onClick={handleTest}
                disabled={testStatus === "testing" || !form.endpoint || !form.apiKey}
              >
                {testStatus === "testing" ? "テスト中..." : "接続テスト"}
              </Button>
              <Button onClick={handleSave}>保存</Button>
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
        </Card>
      </div>
    </Theme>
  );
}
