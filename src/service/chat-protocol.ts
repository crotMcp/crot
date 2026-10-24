import { z } from "zod";
export const ChatProviderSchema = z.enum(["OpenAI", "Anthropic", "Local HTTP"]);
export type ChatProvider = z.infer<typeof ChatProviderSchema>;
export const ChatConfigureSchema = z
  .object({
    provider: ChatProviderSchema,
    endpoint: z.string().url().max(2048).optional(),
    credential: z
      .string()
      .max(8192)
      .regex(/^[^\r\n\0]*$/)
      .optional(),
  })
  .strict();
export const ChatStartSchema = z
  .object({
    provider: ChatProviderSchema,
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\0]*$/),
    message: z.string().min(1).max(32000),
    tools: z.array(z.string().min(1).max(128)).max(16).default([]),
    attachments: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[^\r\n\0]*$/),
            mime: z.enum(["text/plain", "image/png", "image/jpeg", "image/webp"]),
            data: z
              .string()
              .max(128000)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict(),
      )
      .max(4)
      .default([]),
  })
  .strict()
  .refine(
    (p) => p.attachments.reduce((n, a) => n + a.data.length, 0) <= 128000,
    "Attachments exceed 96 KB decoded in total",
  );
export type ChatStart = z.infer<typeof ChatStartSchema>;
