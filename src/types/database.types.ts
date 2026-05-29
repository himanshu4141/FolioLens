export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      benchmark_mapping: {
        Row: {
          benchmark_index: string
          benchmark_index_symbol: string
          id: string
          scheme_category: string | null
          valid_from: string
        }
        Insert: {
          benchmark_index: string
          benchmark_index_symbol: string
          id?: string
          scheme_category?: string | null
          valid_from?: string
        }
        Update: {
          benchmark_index?: string
          benchmark_index_symbol?: string
          id?: string
          scheme_category?: string | null
          valid_from?: string
        }
        Relationships: []
      }
      cas_import: {
        Row: {
          created_at: string
          error_message: string | null
          funds_updated: number
          id: string
          import_source: Database["public"]["Enums"]["import_source"]
          import_status: Database["public"]["Enums"]["import_status"]
          imported_at: string
          raw_payload: Json | null
          transactions_added: number
          user_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          funds_updated?: number
          id?: string
          import_source: Database["public"]["Enums"]["import_source"]
          import_status?: Database["public"]["Enums"]["import_status"]
          imported_at?: string
          raw_payload?: Json | null
          transactions_added?: number
          user_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          funds_updated?: number
          id?: string
          import_source?: Database["public"]["Enums"]["import_source"]
          import_status?: Database["public"]["Enums"]["import_status"]
          imported_at?: string
          raw_payload?: Json | null
          transactions_added?: number
          user_id?: string
        }
        Relationships: []
      }
      cas_inbound_session: {
        Row: {
          created_at: string
          inbound_email_address: string
          inbound_email_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          inbound_email_address: string
          inbound_email_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          inbound_email_address?: string
          inbound_email_id?: string
          user_id?: string
        }
        Relationships: []
      }
      fund_portfolio_composition: {
        Row: {
          cash_pct: number
          debt_pct: number
          disclosure_date: string | null
          equity_pct: number
          id: string
          large_cap_pct: number | null
          mid_cap_pct: number | null
          not_classified_pct: number | null
          other_pct: number
          portfolio_date: string
          raw_debt_holdings: Json | null
          scheme_code: number
          sector_allocation: Json | null
          small_cap_pct: number | null
          source: string
          source_url: string | null
          synced_at: string
          top_holdings: Json | null
        }
        Insert: {
          cash_pct?: number
          debt_pct?: number
          disclosure_date?: string | null
          equity_pct?: number
          id?: string
          large_cap_pct?: number | null
          mid_cap_pct?: number | null
          not_classified_pct?: number | null
          other_pct?: number
          portfolio_date: string
          raw_debt_holdings?: Json | null
          scheme_code: number
          sector_allocation?: Json | null
          small_cap_pct?: number | null
          source?: string
          source_url?: string | null
          synced_at?: string
          top_holdings?: Json | null
        }
        Update: {
          cash_pct?: number
          debt_pct?: number
          disclosure_date?: string | null
          equity_pct?: number
          id?: string
          large_cap_pct?: number | null
          mid_cap_pct?: number | null
          not_classified_pct?: number | null
          other_pct?: number
          portfolio_date?: string
          raw_debt_holdings?: Json | null
          scheme_code?: number
          sector_allocation?: Json | null
          small_cap_pct?: number | null
          source?: string
          source_url?: string | null
          synced_at?: string
          top_holdings?: Json | null
        }
        Relationships: []
      }
      index_history: {
        Row: {
          close_value: number
          created_at: string
          id: string
          index_date: string
          index_name: string
          index_symbol: string
          ntr_value: number | null
          source: string
        }
        Insert: {
          close_value: number
          created_at?: string
          id?: string
          index_date: string
          index_name: string
          index_symbol: string
          ntr_value?: number | null
          source?: string
        }
        Update: {
          close_value?: number
          created_at?: string
          id?: string
          index_date?: string
          index_name?: string
          index_symbol?: string
          ntr_value?: number | null
          source?: string
        }
        Relationships: []
      }
      nav_history: {
        Row: {
          created_at: string
          id: string
          nav: number
          nav_date: string
          scheme_code: number
        }
        Insert: {
          created_at?: string
          id?: string
          nav: number
          nav_date: string
          scheme_code: number
        }
        Update: {
          created_at?: string
          id?: string
          nav?: number
          nav_date?: string
          scheme_code?: number
        }
        Relationships: []
      }
      scheme_master: {
        Row: {
          amc_name: string | null
          amc_slug: string | null
          aum_cr: number | null
          benchmark_index: string | null
          benchmark_index_symbol: string | null
          created_at: string
          declared_benchmark_name: string | null
          exit_load: string | null
          expense_ratio: number | null
          family_name: string | null
          fund_manager: string | null
          fund_meta_synced_at: string | null
          isin: string | null
          launch_date: string | null
          mfdata_family_id: number | null
          mfdata_meta_synced_at: string | null
          min_additional: number | null
          min_lumpsum: number | null
          min_sip_amount: number | null
          morningstar_rating: number | null
          openfolio_meta_synced_at: string | null
          option_type: string | null
          period_returns: Json | null
          plan_type: string | null
          portfolio_turnover: number | null
          related_variants: Json | null
          risk_label: string | null
          risk_ratios: Json | null
          scheme_category: string | null
          scheme_code: number
          scheme_name: string
          sebi_category: string | null
          ter_date: string | null
          updated_at: string
        }
        Insert: {
          amc_name?: string | null
          amc_slug?: string | null
          aum_cr?: number | null
          benchmark_index?: string | null
          benchmark_index_symbol?: string | null
          created_at?: string
          declared_benchmark_name?: string | null
          exit_load?: string | null
          expense_ratio?: number | null
          family_name?: string | null
          fund_manager?: string | null
          fund_meta_synced_at?: string | null
          isin?: string | null
          launch_date?: string | null
          mfdata_family_id?: number | null
          mfdata_meta_synced_at?: string | null
          min_additional?: number | null
          min_lumpsum?: number | null
          min_sip_amount?: number | null
          morningstar_rating?: number | null
          openfolio_meta_synced_at?: string | null
          option_type?: string | null
          period_returns?: Json | null
          plan_type?: string | null
          portfolio_turnover?: number | null
          related_variants?: Json | null
          risk_label?: string | null
          risk_ratios?: Json | null
          scheme_category?: string | null
          scheme_code: number
          scheme_name: string
          sebi_category?: string | null
          ter_date?: string | null
          updated_at?: string
        }
        Update: {
          amc_name?: string | null
          amc_slug?: string | null
          aum_cr?: number | null
          benchmark_index?: string | null
          benchmark_index_symbol?: string | null
          created_at?: string
          declared_benchmark_name?: string | null
          exit_load?: string | null
          expense_ratio?: number | null
          family_name?: string | null
          fund_manager?: string | null
          fund_meta_synced_at?: string | null
          isin?: string | null
          launch_date?: string | null
          mfdata_family_id?: number | null
          mfdata_meta_synced_at?: string | null
          min_additional?: number | null
          min_lumpsum?: number | null
          min_sip_amount?: number | null
          morningstar_rating?: number | null
          openfolio_meta_synced_at?: string | null
          option_type?: string | null
          period_returns?: Json | null
          plan_type?: string | null
          portfolio_turnover?: number | null
          related_variants?: Json | null
          risk_label?: string | null
          risk_ratios?: Json | null
          scheme_category?: string | null
          scheme_code?: number
          scheme_name?: string
          sebi_category?: string | null
          ter_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      transaction: {
        Row: {
          amount: number
          cas_import_id: string | null
          created_at: string
          folio_number: string | null
          fund_id: string
          id: string
          nav_at_transaction: number
          transaction_date: string
          transaction_type: Database["public"]["Enums"]["transaction_type"]
          units: number
          user_id: string
        }
        Insert: {
          amount: number
          cas_import_id?: string | null
          created_at?: string
          folio_number?: string | null
          fund_id: string
          id?: string
          nav_at_transaction: number
          transaction_date: string
          transaction_type: Database["public"]["Enums"]["transaction_type"]
          units: number
          user_id: string
        }
        Update: {
          amount?: number
          cas_import_id?: string | null
          created_at?: string
          folio_number?: string | null
          fund_id?: string
          id?: string
          nav_at_transaction?: number
          transaction_date?: string
          transaction_type?: Database["public"]["Enums"]["transaction_type"]
          units?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transaction_cas_import_fk"
            columns: ["cas_import_id"]
            isOneToOne: false
            referencedRelation: "cas_import"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "fund"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "user_fund"
            referencedColumns: ["id"]
          },
        ]
      }
      user_feedback: {
        Row: {
          app_version: string | null
          attachment_path: string | null
          body: string
          created_at: string
          id: string
          status: string
          title: string
          type: string
          update_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          attachment_path?: string | null
          body: string
          created_at?: string
          id?: string
          status?: string
          title: string
          type: string
          update_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          attachment_path?: string | null
          body?: string
          created_at?: string
          id?: string
          status?: string
          title?: string
          type?: string
          update_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_fund: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          scheme_code: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          scheme_code: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          scheme_code?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_fund_scheme_code_fk"
            columns: ["scheme_code"]
            isOneToOne: false
            referencedRelation: "scheme_master"
            referencedColumns: ["scheme_code"]
          },
        ]
      }
      user_profile: {
        Row: {
          cas_auto_forward_setup_completed_at: string | null
          cas_inbox_confirmation_url: string | null
          cas_inbox_token: string
          created_at: string
          dob: string | null
          kfintech_email: string | null
          pan: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cas_auto_forward_setup_completed_at?: string | null
          cas_inbox_confirmation_url?: string | null
          cas_inbox_token?: string
          created_at?: string
          dob?: string | null
          kfintech_email?: string | null
          pan: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cas_auto_forward_setup_completed_at?: string | null
          cas_inbox_confirmation_url?: string | null
          cas_inbox_token?: string
          created_at?: string
          dob?: string | null
          kfintech_email?: string | null
          pan?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      fund: {
        Row: {
          aum_cr: number | null
          benchmark_index: string | null
          benchmark_index_symbol: string | null
          created_at: string | null
          declared_benchmark_name: string | null
          expense_ratio: number | null
          fund_meta_synced_at: string | null
          id: string | null
          is_active: boolean | null
          isin: string | null
          mfdata_family_id: number | null
          mfdata_meta_synced_at: string | null
          min_sip_amount: number | null
          morningstar_rating: number | null
          related_variants: Json | null
          risk_label: string | null
          scheme_category: string | null
          scheme_code: number | null
          scheme_name: string | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_fund_scheme_code_fk"
            columns: ["scheme_code"]
            isOneToOne: false
            referencedRelation: "scheme_master"
            referencedColumns: ["scheme_code"]
          },
        ]
      }
    }
    Functions: {
      gen_cas_inbox_token: { Args: { p_user_id: string }; Returns: string }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      import_source: "email" | "qr" | "pdf"
      import_status: "pending" | "success" | "failed"
      transaction_type:
        | "purchase"
        | "redemption"
        | "switch_in"
        | "switch_out"
        | "dividend_reinvest"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      import_source: ["email", "qr", "pdf"],
      import_status: ["pending", "success", "failed"],
      transaction_type: [
        "purchase",
        "redemption",
        "switch_in",
        "switch_out",
        "dividend_reinvest",
      ],
    },
  },
} as const
