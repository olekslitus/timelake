import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Storage & configuration" }

export default function Page() {
  return (
    <DocPage href="/docs/storage">
      <h1>Storage & configuration</h1>
      <p>
        Timelake uses the Rust <code>object_store</code> crate for everything: Iceberg metadata, Parquet data and query scans.
        The warehouse URL picks the backend.
      </p>
      <table>
        <thead>
          <tr>
            <th>Scheme</th>
            <th>Backend</th>
            <th>Credentials</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              local path, <code>file://</code>
            </td>
            <td>Local filesystem</td>
            <td>—</td>
          </tr>
          <tr>
            <td>
              <code>s3://</code>, <code>s3a://</code>
            </td>
            <td>Amazon S3 and S3-compatible stores</td>
            <td>
              <code>AWS_*</code> environment variables, plus options
            </td>
          </tr>
          <tr>
            <td>
              <code>gs://</code>
            </td>
            <td>Google Cloud Storage</td>
            <td>
              <code>GOOGLE_*</code> environment variables, plus options
            </td>
          </tr>
          <tr>
            <td>
              <code>az://</code>, <code>abfs://</code>, <code>abfss://</code>
            </td>
            <td>Azure Blob Storage / ADLS</td>
            <td>
              <code>AZURE_*</code> environment variables, plus options
            </td>
          </tr>
          <tr>
            <td>
              <code>memory://</code>
            </td>
            <td>In-memory (tests)</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>

      <h2>Options</h2>
      <p>
        Options are <code>object_store</code> configuration keys: <code>-o key=value</code> on the CLI,{" "}
        <code>storage_options</code> in Python. Unknown keys are an error. Common S3 keys:
      </p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>aws_region</code>
            </td>
            <td>Bucket region.</td>
          </tr>
          <tr>
            <td>
              <code>aws_access_key_id</code>, <code>aws_secret_access_key</code>, <code>aws_session_token</code>
            </td>
            <td>Static credentials (otherwise the environment and instance credentials are used).</td>
          </tr>
          <tr>
            <td>
              <code>aws_endpoint</code>
            </td>
            <td>Custom endpoint for S3-compatible stores, e.g. <code>http://localhost:9000</code>.</td>
          </tr>
          <tr>
            <td>
              <code>aws_allow_http</code>
            </td>
            <td>
              <code>true</code> to allow a plain-HTTP endpoint.
            </td>
          </tr>
        </tbody>
      </table>
      <pre>{`timelake -w s3://lake/wh -o aws_endpoint=http://localhost:9000 -o aws_allow_http=true ls`}</pre>
      <pre>{`timelake.Lake("s3://lake/wh", storage_options={
    "aws_endpoint": "http://localhost:9000",
    "aws_allow_http": "true",
})`}</pre>

      <h2>Conditional writes are required</h2>
      <p>
        Commits create the next <code>vN.metadata.json</code> with put-if-absent: on S3 that is <code>If-None-Match: *</code>,
        which AWS S3 has supported since 2024; GCS and Azure use their own preconditions. A store that ignores the condition
        would let two concurrent writers both believe they committed. Timelake has been tested on local disk and on RustFS; with
        a store you haven’t tested, check that a second create of the same table fails.
      </p>

      <h2>Environment</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>TIMELAKE_WAREHOUSE</code>
            </td>
            <td>Default warehouse for the CLI.</td>
          </tr>
        </tbody>
      </table>
    </DocPage>
  )
}
