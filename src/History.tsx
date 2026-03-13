import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";
import { useSettings } from "./useSettings";

interface LogEntry {
  timestamp: string;
  transcription: string;
  formatted: string;
  error?: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

export default function History() {
  const { settings } = useSettings();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const logFolder =
          settings.logFolder.trim() ||
          (await invoke<string>("get_app_log_dir"));
        const raw = await invoke<string[]>("read_logs", {
          folder: logFolder,
          limit: 100,
        });
        const parsed = raw
          .map((json) => {
            try {
              return JSON.parse(json) as LogEntry;
            } catch {
              return null;
            }
          })
          .filter(
            (e): e is LogEntry =>
              e !== null && (!!e.formatted || !!e.transcription)
          );
        setEntries(parsed);
      } catch (e) {
        console.error("[FreeVoice] read_logs failed", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleCopy = async (text: string, idx: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  if (loading) {
    return (
      <Box py="6">
        <Text size="2" color="gray">読み込み中...</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box py="6">
        <Text size="2" color="gray">
          履歴がありません。音声入力を行うとここに表示されます。
        </Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="3">
      {entries.map((entry, i) => {
        const displayText = entry.formatted || entry.transcription;
        return (
          <Card key={i} variant="surface" size="2">
            <Flex direction="column" gap="2">
              <Flex justify="between" align="center">
                <Text size="1" color="gray">
                  {timeAgo(entry.timestamp)}
                </Text>
                <Button
                  size="1"
                  variant="ghost"
                  onClick={() => handleCopy(displayText, i)}
                >
                  {copiedIdx === i ? "Copied!" : "Copy"}
                </Button>
              </Flex>
              <Text size="2" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                {displayText}
              </Text>
            </Flex>
          </Card>
        );
      })}
    </Flex>
  );
}
