/** `restore_job_id` vem preenchido enquanto um restore do recurso está na fila ou rodando; ausente ou `null` = sem restore. */
export function isRestoring(status: object | undefined): boolean {
  const id = (status as { restore_job_id?: string | null } | undefined)?.restore_job_id;
  return typeof id === "string" && id !== "";
}
