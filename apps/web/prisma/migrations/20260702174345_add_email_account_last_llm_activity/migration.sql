-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "lastLlmActivityAt" TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "ClassificationFeedback_emailAccountId_sender_ruleId_messageId_e" RENAME TO "ClassificationFeedback_emailAccountId_sender_ruleId_message_key";

-- RenameIndex
ALTER INDEX "DraftSendLog_replyMemoryProcessedAt_replyMemoryAttemptCount_cre" RENAME TO "DraftSendLog_replyMemoryProcessedAt_replyMemoryAttemptCount_idx";

-- RenameIndex
ALTER INDEX "ReplyMemory_emailAccountId_kind_scopeType_scopeValue_content_ke" RENAME TO "ReplyMemory_emailAccountId_kind_scopeType_scopeValue_conten_key";

-- RenameIndex
ALTER INDEX "ReplyMemorySource_replyMemoryId_learnedWritingStyleAnalyzedAt_c" RENAME TO "ReplyMemorySource_replyMemoryId_learnedWritingStyleAnalyzed_idx";
