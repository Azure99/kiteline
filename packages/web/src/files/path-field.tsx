import { useEffect, useImperativeHandle, useRef, type ComponentProps } from "react";
import { Textarea } from "../components/ui/textarea";

export function PathField({ ref, ...props }: ComponentProps<typeof Textarea>) {
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => field.current!, []);
  useEffect(() => {
    const input = field.current!;
    function handleBeforeInput(event: InputEvent) {
      if (event.inputType !== "insertLineBreak") return;
      event.preventDefault();
      input.form?.requestSubmit();
    }
    input.addEventListener("beforeinput", handleBeforeInput);
    return () => input.removeEventListener("beforeinput", handleBeforeInput);
  }, []);
  return <Textarea {...props} ref={field} autoCapitalize="none" enterKeyHint="done" />;
}
