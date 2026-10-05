import { useCallback, useState } from "react";
import { copyText } from "./clipboard";

export function useCopyFeedback() {
  const [copied, setCopied] = useState("");
  const [error, setError] = useState<{ text: string; error: unknown }>();
  const copy = useCallback(async (text: string) => {
    try {
      await copyText(text);
      setCopied(text);
      setError(undefined);
    } catch (error) {
      setError({ text, error });
    }
  }, []);
  const reset = useCallback(() => {
    setCopied("");
    setError(undefined);
  }, []);
  return { copied, error, copy, reset };
}
