import { useCallback, useState } from "react";
import { copyText } from "./clipboard";

export function useCopyFeedback() {
  const [copied, setCopied] = useState("");
  const [error, setError] = useState<{ id: string; error: unknown }>();
  const [pending, setPending] = useState(false);
  const reset = useCallback(() => {
    setCopied("");
    setError(undefined);
  }, []);
  const copy = useCallback(
    async (text: string, id = text) => {
      reset();
      setPending(true);
      try {
        await copyText(text);
        setCopied(id);
        setError(undefined);
      } catch (error) {
        setError({ id, error });
      } finally {
        setPending(false);
      }
    },
    [reset],
  );
  return { copied, error, pending, copy, reset };
}
