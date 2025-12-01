import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

export class AISummarizer {
  private client: Anthropic | null = null;
  private enabled: boolean = false;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey, fetch: fetch as unknown as typeof globalThis.fetch });
      this.enabled = true;
      console.log('✨ AI summarization enabled');
    } else {
      console.log('ℹ️  AI summarization disabled (no API key)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate an intelligent product summary using Claude
   * @param pageText - The rendered text from the order page
   * @param orderId - The order ID
   * @returns A concise, natural language summary
   */
  async generateProductSummary(pageText: string, orderId: string): Promise<string> {
    if (!this.client || !this.enabled) {
      throw new Error('AI summarization is not enabled');
    }

    try {
      console.log(`🤖 Generating AI summary for order ${orderId}...`);

      const prompt = `You are analyzing an Amazon order page. Extract the product information and create a very brief, natural language summary that will be the memo field on a credit/debit account entry.

Order Page Text:
${pageText.substring(0, 4000)}

Instructions:
1. Identify all product names and quantities from the order
2. Create a concise summary describing what was ordered
3. Group related items when appropriate (e.g., "USB charging accessories" instead of listing each cable)
4. Keep it to 1-2 very short descriptions maximum
5. Do NOT include prices, order numbers, or shipping info
6. Format as a natural phrase (e.g., "Kitchen gadgets and cookware" or "2 USB-C cables and a phone case")
7. Do NOT include any lead in phrases such as "The order includes ... "; only the product details should be included.

Return only the product summary, nothing else.`;

      const message = await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const summary = message.content[0].type === 'text'
        ? message.content[0].text.trim()
        : 'Order details';

      console.log(`✅ AI summary generated: ${summary}`);
      return summary;
    } catch (error) {
      console.error(`❌ AI summarization failed:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Create a complete memo with order ID and AI-generated summary
   */
  async createMemo(pageText: string, orderId: string): Promise<string> {
    try {
      const summary = await this.generateProductSummary(pageText, orderId);
      return `[${orderId}] - ${summary}`;
    } catch (error) {
      console.error(`❌ Failed to create AI memo for ${orderId}`);
      return `[${orderId}] - Order details (AI summary unavailable)`;
    }
  }
}

export default AISummarizer;
