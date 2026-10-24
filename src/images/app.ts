import * as vscode from "vscode";

/** App que roda de uma imagem Docker própria: `custom_image` preenchido. Payload antigo não traz o campo. */
export function isImageApp(app: unknown): app is { custom_image: { image_id: string; port?: number | null } } {
  const image = (app as { custom_image?: unknown } | null | undefined)?.custom_image;
  return !!image && typeof image === "object";
}

export interface ImageCommitSummary {
  imageId: string;
  text: string;
}

/**
 * Resposta do upload de arquivos de um app de imagem: o envio é um commit que rebuilda a imagem.
 * Devolve `undefined` quando a resposta é de um deploy comum. O texto é próprio e traduzido: a `message`
 * do servidor vem em inglês e não é mostrada.
 */
export function summarizeImageCommit(result: unknown, imageName?: string): ImageCommitSummary | undefined {
  const response = result as { image_build?: { image_id?: unknown } | null } | null | undefined;
  const imageId = response?.image_build?.image_id;
  if (typeof imageId !== "string") {return undefined;}
  const text = imageName
    ? vscode.l10n.t("Image {0} is being rebuilt; only this application restarts when the build finishes. The other applications on the image keep the current version.", imageName)
    : vscode.l10n.t("The image is being rebuilt; only this application restarts when the build finishes. The other applications on the image keep the current version.");
  return { imageId, text };
}
