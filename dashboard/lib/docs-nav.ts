export type DocsLink = { href: string; label: string; items?: DocsLink[] }

export const DOCS_NAV: { title: string; items: DocsLink[] }[] = [
  {
    title: "Getting started",
    items: [
      { href: "/docs", label: "Introduction" },
      {
        href: "/docs/quick-start",
        label: "Quick start",
        items: [
          {
            href: "/docs/quick-start/local",
            label: "Local",
            items: [
              { href: "/docs/quick-start/local/setup", label: "Setup" },
              { href: "/docs/quick-start/local/folder", label: "A folder and cron" },
              { href: "/docs/quick-start/local/python", label: "Appending from Python" },
              { href: "/docs/quick-start/local/local-s3", label: "A local S3" },
              { href: "/docs/quick-start/local/checks", label: "Scheduled checks" },
            ],
          },
          {
            href: "/docs/quick-start/aws",
            label: "AWS",
            items: [
              { href: "/docs/quick-start/aws/setup", label: "Setup" },
              { href: "/docs/quick-start/aws/files", label: "Files to S3" },
              { href: "/docs/quick-start/aws/kinesis", label: "Kinesis Data Streams" },
              { href: "/docs/quick-start/aws/sqs", label: "SQS" },
              { href: "/docs/quick-start/aws/iot-core", label: "IoT Core" },
              { href: "/docs/quick-start/aws/firehose", label: "Data Firehose" },
              { href: "/docs/quick-start/aws/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/azure",
            label: "Azure",
            items: [
              { href: "/docs/quick-start/azure/setup", label: "Setup" },
              { href: "/docs/quick-start/azure/files", label: "Files to Blob Storage" },
              { href: "/docs/quick-start/azure/event-hubs", label: "Event Hubs" },
              { href: "/docs/quick-start/azure/service-bus", label: "Service Bus" },
              { href: "/docs/quick-start/azure/iot-hub", label: "IoT Hub" },
              { href: "/docs/quick-start/azure/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/gcp",
            label: "Google Cloud",
            items: [
              { href: "/docs/quick-start/gcp/setup", label: "Setup" },
              { href: "/docs/quick-start/gcp/files", label: "Files to Cloud Storage" },
              { href: "/docs/quick-start/gcp/pubsub-files", label: "Pub/Sub to Cloud Storage" },
              { href: "/docs/quick-start/gcp/pubsub-pull", label: "Pub/Sub, pulled every minute" },
              { href: "/docs/quick-start/gcp/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/cloudflare",
            label: "Cloudflare",
            items: [
              { href: "/docs/quick-start/cloudflare/setup", label: "Setup" },
              { href: "/docs/quick-start/cloudflare/worker-writer", label: "Queue with a consumer Worker" },
              { href: "/docs/quick-start/cloudflare/files", label: "Files to R2" },
              { href: "/docs/quick-start/cloudflare/queues", label: "Queue with a pull consumer" },
              { href: "/docs/quick-start/cloudflare/notifications", label: "R2 event notifications" },
              { href: "/docs/quick-start/cloudflare/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/fly",
            label: "Fly.io",
            items: [
              { href: "/docs/quick-start/fly/setup", label: "Setup" },
              { href: "/docs/quick-start/fly/http-buffered", label: "HTTP intake, buffered" },
              { href: "/docs/quick-start/fly/http-landing", label: "HTTP intake to landing objects" },
              { href: "/docs/quick-start/fly/mqtt", label: "MQTT worker" },
              { href: "/docs/quick-start/fly/tigris-notifications", label: "Tigris notifications" },
              { href: "/docs/quick-start/fly/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/vercel",
            label: "Vercel",
            items: [
              { href: "/docs/quick-start/vercel/setup", label: "Setup" },
              { href: "/docs/quick-start/vercel/http-direct", label: "HTTP, appended directly" },
              { href: "/docs/quick-start/vercel/queues-push", label: "Vercel Queues, pushed" },
              { href: "/docs/quick-start/vercel/queues-cron", label: "Vercel Queues, drained by cron" },
              { href: "/docs/quick-start/vercel/files-cron", label: "Files, appended by cron" },
              { href: "/docs/quick-start/vercel/checks", label: "Checks and maintenance" },
            ],
          },
          {
            href: "/docs/quick-start/tigris",
            label: "Tigris",
            items: [
              { href: "/docs/quick-start/tigris/setup", label: "Setup" },
              { href: "/docs/quick-start/tigris/files-poller", label: "Files and a poller" },
              { href: "/docs/quick-start/tigris/notifications", label: "Object notifications" },
              { href: "/docs/quick-start/tigris/direct", label: "Direct appends" },
              { href: "/docs/quick-start/tigris/checks", label: "Checks and maintenance" },
            ],
          },
        ],
      },
      { href: "/docs/how-it-works", label: "How it works" },
      { href: "/docs/concepts", label: "Concepts" },
      { href: "/docs/glossary", label: "Glossary" },
    ],
  },
  {
    title: "Using Timelake",
    items: [
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/python", label: "Python API" },
      { href: "/docs/typescript", label: "TypeScript client" },
      { href: "/docs/querying", label: "Querying" },
      { href: "/docs/rollups", label: "Rollups" },
      { href: "/docs/settings", label: "Settings" },
      { href: "/docs/storage", label: "Storage & configuration" },
      { href: "/docs/upgrading", label: "Upgrading" },
    ],
  },
  {
    title: "Internals",
    items: [
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/docs/codebase", label: "Codebase tour" },
      { href: "/docs/development", label: "Development" },
      { href: "/docs/benchmarks", label: "Benchmarks" },
      { href: "/docs/performance", label: "Performance history" },
      { href: "/docs/limitations", label: "Limitations" },
      { href: "/docs/changelog", label: "Changelog" },
      { href: "/docs/credits", label: "Credits" },
    ],
  },
]

const flatten = (links: DocsLink[]): DocsLink[] => links.flatMap((l) => [l, ...flatten(l.items ?? [])])

/** Every docs page in sidebar order, sub-pages right after their parent. */
export const DOCS_PAGES: DocsLink[] = flatten(DOCS_NAV.flatMap((g) => g.items))

/** Whether `href` is `link` or one of its sub-pages, at any depth. */
export const contains = (link: DocsLink, href: string | null): boolean =>
  link.href === href || (link.items ?? []).some((i) => contains(i, href))
