// Supabase database type definitions
//
// Mirrors the schema defined in supabase/schema.sql.
// These types are consumed by the Supabase client generics to provide
// type-safe queries and subscriptions.
//
// The shape follows the Supabase CLI `supabase gen types` convention.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      gold_prices: {
        Row: {
          id: number;
          price: number;
          currency: string;
          source_timestamp: string;
          created_at: string;
        };
        Insert: {
          id?: never;
          price: number;
          currency: string;
          source_timestamp: string;
          created_at?: string;
        };
        Update: {
          id?: never;
          price?: number;
          currency?: string;
          source_timestamp?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      cot_reports: {
        Row: {
          id: number;
          report_date: string;
          market: string;
          open_interest: number;
          commercials_long: number;
          commercials_short: number;
          commercials_net: number;
          large_spec_long: number;
          large_spec_short: number;
          large_spec_net: number;
          small_traders_long: number;
          small_traders_short: number;
          small_traders_net: number;
          created_at: string;
        };
        Insert: {
          id?: never;
          report_date: string;
          market?: string;
          open_interest: number;
          commercials_long: number;
          commercials_short: number;
          commercials_net: number;
          large_spec_long: number;
          large_spec_short: number;
          large_spec_net: number;
          small_traders_long: number;
          small_traders_short: number;
          small_traders_net: number;
          created_at?: string;
        };
        Update: {
          id?: never;
          report_date?: string;
          market?: string;
          open_interest?: number;
          commercials_long?: number;
          commercials_short?: number;
          commercials_net?: number;
          large_spec_long?: number;
          large_spec_short?: number;
          large_spec_net?: number;
          small_traders_long?: number;
          small_traders_short?: number;
          small_traders_net?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      cot_history: {
        Row: {
          id: number;
          report_date: string;
          managed_money_net: number;
          commercials_net: number;
          open_interest: number;
          created_at: string;
        };
        Insert: {
          id?: never;
          report_date: string;
          managed_money_net: number;
          commercials_net: number;
          open_interest: number;
          created_at?: string;
        };
        Update: {
          id?: never;
          report_date?: string;
          managed_money_net?: number;
          commercials_net?: number;
          open_interest?: number;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
