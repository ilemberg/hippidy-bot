-- Slice 5A, part E1 (decision 167): the product agent records approvals and links or creates
-- projects through custom tools the API answers. Each call is answered once: its write is
-- keyed on the call's id, so a retry or a lost sync lease cannot record it twice.
--
-- Additive only (decision 86): nullable columns, unique when set. The code before this never
-- reads them; the code after it (part E2) fills them for writes made by a tool call.
alter table public.approvals
  add column custom_tool_use_id text unique;

alter table public.projects
  add column custom_tool_use_id text unique;
