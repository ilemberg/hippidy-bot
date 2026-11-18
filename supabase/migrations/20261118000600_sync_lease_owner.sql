-- Slice 4, pull request A3 (decision 121): who holds a conversation's sync lease.
--
-- The lease is a time (`sync_lease_until`), so a sync that runs past it can still release or
-- extend a lease that another sync has claimed since. From pull request B, each claim writes a
-- fresh token here, and releasing or renewing the lease checks it. Long coding turns make a
-- slow sync more likely.
--
-- Shipped on its own, before the code that uses it (decision 86): the code before it never
-- reads or writes the column, and the code after it treats a null owner as no lease held.
alter table public.conversations
  add column sync_lease_owner uuid;
