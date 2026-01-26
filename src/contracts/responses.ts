import { z } from "zod";

// Shared schemas
const AuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const TagSchema = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  slug: z.string(),
  singleSelect: z.boolean(),
});

// GET /api/tags
const TagCategorySchema = z.object({
  category: z.string(),
  tags: z.array(TagSchema),
});

export const TagsResponseSchema = z.object({
  categories: z.array(TagCategorySchema),
});

// GET /api/books
export const BookListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  coverUrl: z.string().nullable(),
  publishedYear: z.number().nullable(),
  pageCount: z.number().nullable(),
  authors: z.array(AuthorSchema),
  tags: z.array(TagSchema),
});

const FiltersAppliedSchema = z.object({
  q: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const BooksListResponseSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
  filtersApplied: FiltersAppliedSchema,
  sort: z.string(),
  items: z.array(BookListItemSchema),
});

// GET /api/books/:slug
const BookDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  coverUrl: z.string().nullable(),
  publishedYear: z.number().nullable(),
  pageCount: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  authors: z.array(AuthorSchema),
  tags: z.array(TagSchema),
});

export const BookDetailResponseSchema = z.object({
  book: BookDetailSchema,
});

// GET /api/collections
export const CollectionListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  coverUrl: z.string().nullable(),
  bookCount: z.number().int().min(0),
  bookCovers: z.array(z.string()), // First 3 book covers from collection
});

export const CollectionsListResponseSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(50),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(1),
  items: z.array(CollectionListItemSchema),
});

// GET /api/collections/:slug
export const CollectionDetailResponseSchema = z.object({
  collection: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    coverUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    books: z.array(BookListItemSchema),
  }),
});
