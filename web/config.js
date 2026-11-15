// Where the sheet inventory lives (Supabase). The publishable key is meant to be public:
// what it can do is limited by the database rules in supabase/schema.sql (anyone can read
// the inventory, only emails on the editors list can change it).
window.ROSCAM_CONFIG = {
  supabaseUrl: 'https://ugapgbvcnizrirzynhbw.supabase.co',
  supabaseKey: 'sb_publishable_k0-Dlg_Gs9BilEcrumI77A_NAev4E-l',
  // Shared team account; prefilled on the sign-in form. Must also be in public.editors.
  teamEmail: 'roscam@frc5572.org',
};
