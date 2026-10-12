import { CircleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function ErrorState({ title = "Could not read the lake", error }: { title?: string; error: unknown }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  )
}
