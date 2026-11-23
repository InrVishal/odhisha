"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { callApi } from "@/components/dashboard/api";
import { buttonClass, inputClass } from "@/components/dashboard/ui";

export interface WorkloadOption {
  type: "text_embeddings" | "image_captioning" | "image_resize";
  label: string;
  itemKind: "text" | "image";
  maxItems: number;
  maxItemBytes: number;
  maxTotalBytes: number;
}

const MB = 1024 * 1024;
const fmtMb = (b: number) => `${(b / MB).toFixed(b < MB ? 2 : 1)} MB`;

export function NewJobForm({ workloads, classes }: { workloads: WorkloadOption[]; classes: Array<{ value: string; label: string }> }) {
  const router = useRouter();
  const ids = useId();
  const [type, setType] = useState<WorkloadOption["type"]>(workloads[0]?.type ?? "text_embeddings");
  const [gpuClass, setGpuClass] = useState("cpu");
  const [canaryReuse, setCanaryReuse] = useState(true);
  const [texts, setTexts] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [format, setFormat] = useState("webp");
  const [fit, setFit] = useState("inside");
  const [maxWords, setMaxWords] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const spec = workloads.find((w) => w.type === type);
  if (!spec) return <p>No job types are available right now.</p>;

  const lines = texts.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const textBytes = new TextEncoder().encode(lines.join("\n")).length;
  const fileBytes = files.reduce((s, f) => s + f.size, 0);
  const count = spec.itemKind === "text" ? lines.length : files.length;
  const bytes = spec.itemKind === "text" ? textBytes : fileBytes;

  async function loadTextFile(file: File | undefined) {
    if (!file) return;
    if (file.size > spec!.maxTotalBytes) {
      setError(`That file is ${fmtMb(file.size)}. The limit is ${fmtMb(spec!.maxTotalBytes)}.`);
      return;
    }
    setTexts(await file.text());
    setError(null);
  }

  function check(): string | null {
    if (count === 0) return spec!.itemKind === "text" ? "Add at least one line of text." : "Choose at least one image.";
    if (count > spec!.maxItems) return `That's ${count} items. The limit is ${spec!.maxItems} per job.`;
    if (bytes > spec!.maxTotalBytes) return `That's ${fmtMb(bytes)} of data. The limit is ${fmtMb(spec!.maxTotalBytes)} per job.`;
    if (spec!.itemKind === "image") {
      const big = files.find((f) => f.size > spec!.maxItemBytes);
      if (big) return `${big.name} is ${fmtMb(big.size)}. Each image can be up to ${fmtMb(spec!.maxItemBytes)}.`;
    }
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = check();
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const params =
      type === "image_resize" ? { width, height, format, fit } : type === "image_captioning" ? { maxWords } : {};
    let body: unknown;
    if (spec!.itemKind === "text") {
      body = { workloadType: type, gpuClass, params, texts: lines, canaryReuse };
    } else {
      const form = new FormData();
      form.set("request", JSON.stringify({ workloadType: type, gpuClass, params, canaryReuse }));
      for (const f of files) form.append("images", f, f.name);
      body = form;
    }
    const res = await callApi<{ job: { id: string } }>("POST", "/api/jobs/quote", body);
    if (!res.ok || !res.data) {
      setPending(false);
      setError(res.error ?? "Couldn't get a quote.");
      return;
    }
    router.push(`/dashboard/jobs/${res.data.job.id}`);
  }

  const field = "flex flex-col gap-1";
  const label = "font-medium text-lavender";

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6" noValidate>
      <fieldset className="space-y-2">
        <legend className={label}>What should the PCs do?</legend>
        {workloads.map((w) => (
          <label key={w.type} className="flex items-center gap-2 text-mist">
            <input type="radio" name="workloadType" value={w.type} checked={type === w.type} onChange={() => { setType(w.type); setError(null); }} />
            {w.label}
          </label>
        ))}
      </fieldset>

      <div className={field}>
        <label htmlFor={`${ids}-class`} className={label}>
          Kind of PC
        </label>
        <select id={`${ids}-class`} value={gpuClass} onChange={(e) => setGpuClass(e.target.value)} className={inputClass}>
          {classes.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="text-sm text-mist">Only PCs of this kind run your job. For the laptop demo, pick &quot;Laptop, CPU only&quot;.</p>
      </div>

      <div className="flex items-start gap-2">
        <input
          id={`${ids}-reuse`}
          type="checkbox"
          checked={canaryReuse}
          onChange={(e) => setCanaryReuse(e.target.checked)}
          className="mt-1"
          aria-describedby={`${ids}-reuse-help`}
        />
        <div>
          <label htmlFor={`${ids}-reuse`} className="text-sm text-lavender">
            Let checked pieces of this job be reused as known-answer tests
          </label>
          <p id={`${ids}-reuse-help`} className="text-sm text-mist">
            Once two different people&apos;s PCs agree on a piece, we may send it to a third PC to test that PC is honest, until your
            data is deleted 7 days after the job. Untick to keep your pieces on the PCs that run and check them only. Your own
            job is checked either way.
          </p>
        </div>
      </div>

      {spec.itemKind === "text" ? (
        <div className={field}>
          <label htmlFor={`${ids}-texts`} className={label}>
            Texts, one per line
          </label>
          <textarea
            id={`${ids}-texts`}
            value={texts}
            onChange={(e) => setTexts(e.target.value)}
            rows={10}
            className={`${inputClass} font-mono text-sm`}
            aria-describedby={`${ids}-texts-help`}
          />
          <p id={`${ids}-texts-help`} className="text-sm text-mist">
            {lines.length} lines, {fmtMb(textBytes)}. Up to {spec.maxItems} lines and {fmtMb(spec.maxTotalBytes)} per job.
          </p>
          <label htmlFor={`${ids}-txt`} className="mt-2 text-sm text-lavender">
            Or load a .txt file
          </label>
          <input id={`${ids}-txt`} type="file" accept=".txt,text/plain" onChange={(e) => void loadTextFile(e.target.files?.[0])} className="text-sm text-mist" />
        </div>
      ) : (
        <div className={field}>
          <label htmlFor={`${ids}-images`} className={label}>
            Images (PNG, JPEG or WebP)
          </label>
          <input
            id={`${ids}-images`}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="text-sm text-mist"
            aria-describedby={`${ids}-images-help`}
          />
          <p id={`${ids}-images-help`} className="text-sm text-mist">
            {files.length} chosen, {fmtMb(fileBytes)}. Up to {spec.maxItems} images, {fmtMb(spec.maxItemBytes)} each and{" "}
            {fmtMb(spec.maxTotalBytes)} in total.
          </p>
        </div>
      )}

      {type === "image_resize" ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className={`${label} mb-2`}>Resize settings</legend>
          <div className={field}>
            <label htmlFor={`${ids}-w`} className="text-sm text-lavender">Width (px)</label>
            <input id={`${ids}-w`} type="number" min={1} max={4096} value={width} onChange={(e) => setWidth(Number(e.target.value))} className={inputClass} />
          </div>
          <div className={field}>
            <label htmlFor={`${ids}-h`} className="text-sm text-lavender">Height (px)</label>
            <input id={`${ids}-h`} type="number" min={1} max={4096} value={height} onChange={(e) => setHeight(Number(e.target.value))} className={inputClass} />
          </div>
          <div className={field}>
            <label htmlFor={`${ids}-fit`} className="text-sm text-lavender">Fit</label>
            <select id={`${ids}-fit`} value={fit} onChange={(e) => setFit(e.target.value)} className={inputClass}>
              <option value="inside">Fit inside, keep the shape</option>
              <option value="contain">Fit inside, pad to the size</option>
              <option value="cover">Fill the size, crop the edges</option>
            </select>
          </div>
          <div className={field}>
            <label htmlFor={`${ids}-fmt`} className="text-sm text-lavender">Output format</label>
            <select id={`${ids}-fmt`} value={format} onChange={(e) => setFormat(e.target.value)} className={inputClass}>
              <option value="webp">WebP</option>
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </div>
        </fieldset>
      ) : null}

      {type === "image_captioning" ? (
        <div className={field}>
          <label htmlFor={`${ids}-words`} className={label}>
            Longest caption (words)
          </label>
          <input id={`${ids}-words`} type="number" min={5} max={40} value={maxWords} onChange={(e) => setMaxWords(Number(e.target.value))} className={`${inputClass} w-32`} />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Getting a quote..." : "Get a quote"}
      </button>
    </form>
  );
}
