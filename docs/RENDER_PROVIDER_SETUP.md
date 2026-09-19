# Render provider setup

Operator Creator now has a real Shotstack render adapter.

Required Supabase Edge Function secrets/config:
- SHOTSTACK_API_KEY — Shotstack Sandbox or Production API key.
- RENDER_PROVIDER=shotstack
- SHOTSTACK_ENV=stage for sandbox or v1 for production.

Optional:
- PUBLIC_FUNCTION_BASE_URL — defaults to the project's Supabase functions base URL.

The adapter:
- creates an idempotent render job before submission
- signs private Supabase Storage scene assets for the provider
- submits a real Shotstack Edit API render
- persists the provider job ID
- accepts verified Shotstack webhook callbacks
- polls status as a fallback
- probes completed media with Shotstack FFprobe
- stores the final video in private Supabase Storage
- creates the final asset only after the media exists
- keeps ambiguous provider submissions failed rather than retrying them automatically
- applies retry limits to safe provider-status failures

Do not put provider keys in the browser or repository.
