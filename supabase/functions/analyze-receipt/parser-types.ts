export type ReceiptMerchant = "sams_club" | "walmart" | "misc";
export type ProductIdentifierType = "item_number" | "sku" | "upc" | "unknown";
export type ParserConfidence = "high" | "medium" | "low";

export type ParsedReceiptItem = {
  product_number: string;
  identifier_type?: ProductIdentifierType;
  quantity: number;
  unit_price: number;
  total_price: number;
  instant_savings_discount?: number;
  receipt_label?: string;
  line_index?: number;
  raw_lines?: string[];
  parser_confidence?: ParserConfidence;
};

export type ReceiptParserResult = {
  merchant: ReceiptMerchant;
  item_numbers: string[];
  parsed_items: ParsedReceiptItem[];
  debug?: Record<string, unknown>;
};
