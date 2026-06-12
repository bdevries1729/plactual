# TODO

- on the UI there is toggle for each account which is "sync to actual". Accounts are only generated in actual when the sync triggers and the account does not yet exist (exists only when has actual_account_id in mapping AND check with actual api to see if it exists.) That is, accounts ONLY created during sync. Also, this corresponds to a bool in the mapping db.
- Since accounts only created during sync, we can solve initial budget balance issue. 1. Create new account without initial balance, 2. import transactions (only back to the first date of the month for categorization) 3. get current balance 4. add a new transaction to that account which is the initial balance such that the current balance matches what it should.
- add update item flow for when the plaid token expires, and some check which triggers this programmatically. Maybe in the UI I can ping plaid to see if needs update, then add a message that item needs an update and a button by the item to trigger the update UI. I can test this with `https://plaid.com/docs/api/sandbox/#sandboxitemreset_login`.
- don't let another item be created when it already exists! Probably in the flow when the user selects the same institution let them know it is already linked and then also in the backend don't create the access token if the institution_id matches.
- update logging with debug mode
- fix the log bar on the UI
- UI should list accounts by institution and a total tracker for the institution number
- move account mapping creation to another endpoint besides public token exchange? Or maybe just another function?
- maybe restructure the db so there is items, accounts, and institution schema which are separate.


## Notes:

- [bypass link](https://plaid.com/docs/api/sandbox/#sandboxpublic_tokencreate) in sandbox
- [create transaction link](https://plaid.com/docs/api/sandbox/#sandboxtransactionscreate) for sandbox.

- the token exchange only gives the itemid, but not the institutionid.

