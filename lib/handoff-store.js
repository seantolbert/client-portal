// Service-role persistence for the handoff endpoint.
import { getServiceClient } from './supabase-admin.js';

export function createHandoffStore(db = getServiceClient()) {
  return {
    async createClient(f) {
      const { data, error } = await db.rpc('handoff_create_client', {
        p_prospect_id: f.prospect_id,
        p_business_name: f.business_name,
        p_contact_name: f.contact_name,
        p_email: f.email,
        p_phone: f.phone,
        p_address: f.address,
      });
      if (error) throw new Error(`handoff_create_client: ${error.message}`);
      return data[0];
    },

    async setStripeCustomer(clientId, customerId) {
      const { error } = await db
        .from('clients')
        .update({ stripe_customer_id: customerId })
        .eq('id', clientId)
        .is('stripe_customer_id', null);
      if (error) throw new Error(`set stripe_customer_id: ${error.message}`);
    },

    // Pre-create the auth user so the client can sign in by magic link (public
    // sign-ups stay disabled), then link it as owner.
    async linkMember(clientId, email) {
      const { error: createError } = await db.auth.admin.createUser({ email, email_confirm: true });
      if (createError && createError.code !== 'email_exists') {
        throw new Error(`create auth user: ${createError.message}`);
      }
      const { error } = await db.rpc('handoff_link_member', { p_client_id: clientId, p_email: email });
      if (error) throw new Error(`handoff_link_member: ${error.message}`);
    },
  };
}
