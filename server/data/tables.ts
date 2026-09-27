export const TABLE_NAMES = [
  'Customer',
  'Contact',
  'Article',
  'Quote',
  'QuoteItem',
  'QuoteBundle',
  'Order',
  'OrderItem',
  'Address',
  'Supplier',
  'Textemplate',
  'Attachment',
  'Layout',
  'Invoice',
  'InvoiceItem',
  'ArticleSupplier',
  'SupplierOrder',
  'SupplierOrderItem',
  'DeliveryNote',
  'DeliveryNoteItem',
  'CustomField',
  'Inquiry',
  'PaymentTerm',
  'DeliveryTerm',
  'AiUsageLog',
  'AiQuoteChatLearning',
  'Manufacturer',
  'Category',
  'Company',
  'User',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

const TABLE_SET: ReadonlySet<string> = new Set(TABLE_NAMES);
export const isTableName = (value: string): value is TableName => TABLE_SET.has(value);

export type NumberType =
  | 'customer'
  | 'supplier'
  | 'article'
  | 'inquiry'
  | 'quote'
  | 'order'
  | 'purchase'
  | 'delivery'
  | 'invoice';

export interface NumberSpec {
  type: NumberType;
  table: TableName;
  field: string;
  prefix: string;
  /** The first number handed out is floor + 1. */
  floor: number;
}

export const NUMBER_SPECS: readonly NumberSpec[] = [
  { type: 'customer', table: 'Customer', field: 'customer_no', prefix: 'K-', floor: 1000 },
  { type: 'supplier', table: 'Supplier', field: 'supplier_no', prefix: 'L-', floor: 1000 },
  { type: 'article', table: 'Article', field: 'article_no', prefix: 'A-', floor: 10000 },
  { type: 'inquiry', table: 'Inquiry', field: 'inquiry_no', prefix: 'AN-', floor: 1000 },
  { type: 'quote', table: 'Quote', field: 'quote_no', prefix: 'Q-', floor: 1000 },
  { type: 'order', table: 'Order', field: 'order_no', prefix: 'AB-', floor: 1000 },
  { type: 'purchase', table: 'SupplierOrder', field: 'purchase_no', prefix: 'B-', floor: 1000 },
  { type: 'delivery', table: 'DeliveryNote', field: 'delivery_no', prefix: 'L-', floor: 1000 },
  { type: 'invoice', table: 'Invoice', field: 'invoice_no', prefix: 'R-', floor: 1000 },
];

export const numberSpecForTable = (table: TableName): NumberSpec | undefined =>
  NUMBER_SPECS.find((s) => s.table === table);
export const numberSpecForType = (type: string): NumberSpec | undefined => NUMBER_SPECS.find((s) => s.type === type);

export const LOCKABLE_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'Customer',
  'Supplier',
  'Article',
  'Inquiry',
  'Quote',
  'Order',
  'SupplierOrder',
  'DeliveryNote',
  'Invoice',
]);

export interface AttachmentFieldRule {
  adminOnly: boolean;
}

/** Fields that hold uploaded files, keyed "Table.field". */
export const ATTACHMENT_FIELDS: Readonly<Record<string, AttachmentFieldRule>> = {
  'Company.logo': { adminOnly: true },
  'Company.secondary_logo': { adminOnly: true },
  'Company.sub_logo': { adminOnly: true },
  'Attachment.file': { adminOnly: false },
};

export const attachmentFieldRule = (table: TableName, field: string): AttachmentFieldRule | undefined =>
  ATTACHMENT_FIELDS[`${table}.${field}`];
