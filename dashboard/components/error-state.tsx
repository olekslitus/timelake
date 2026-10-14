import { CircleAlert } from "lucide-react"

import { NotConfigured } from "@/components/not-configured"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { isNotConfigured } from "@/lib/lake/errors"

export function ErrorState({ title = "Could not read the lake", error }: { title?: string; error: unknown }) {
  if (isNotConfigured(error)) return <NotConfigured detail={error.message} />
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
        {error instanceof Error ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  )
}
