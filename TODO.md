# TODO

- on the UI there is toggle for each account which is "sync to actual". Accounts are only generated in actual when the sync triggers and the account does not yet exist (exists only when has actual_account_id in mapping AND check with actual api to see if it exists.) That is, accounts ONLY created during sync. Also, this corresponds to a bool in the mapping db.
- Since accounts only created during sync, we can solve initial budget balance issue. 1. Create new account without initial balance, 2. import transactions (only back to the first date of the month for categorization) 3. get current balance 4. add a new transaction to that account which is the initial balance such that the current balance matches what it should.
- add update item flow for when the plaid token expires, and some check which triggers this programmatically. Maybe in the UI I can ping plaid to see if needs update, then add a message that item needs an update and a button by the item to trigger the update UI. I can test this with `https://plaid.com/docs/api/sandbox/#sandboxitemreset_login`.
- fix the log bar down below in the UI
- UI should list accounts by institution (item) and a total tracker for the institution number
- update the README.md
- add a github workflow which publishes a copy of the container or perhaps the node package.

## Notes:

- [bypass link](https://plaid.com/docs/api/sandbox/#sandboxpublic_tokencreate) in sandbox
- [create transaction link](https://plaid.com/docs/api/sandbox/#sandboxtransactionscreate) for sandbox.
- the token exchange only gives the itemid, but not the institutionid?
