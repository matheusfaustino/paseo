import { z } from "zod";

export const DirectTcpMtlsConfigSchema = z.strictObject({
  identityId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  subjectSummary: z.string().trim().min(1).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  importedAt: z.string().datetime({ offset: true }),
});

export const DirectTcpHostConnectionSchema = z
  .object({
    id: z.string(),
    type: z.literal("directTcp"),
    endpoint: z.string(),
    useTls: z.boolean().optional().default(false),
    password: z.string().optional(),
    mtls: DirectTcpMtlsConfigSchema.optional(),
  })
  .superRefine((connection, context) => {
    if (connection.mtls && connection.useTls !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mtls"],
        message: "mTLS requires TLS",
      });
    }
  });

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;
export type DirectTcpMtlsConfig = z.infer<typeof DirectTcpMtlsConfigSchema>;
