# TODO

- add update item flow for when the plaid token expires, and some check which triggers this programmatically. Ping plaid to see if needs update, then add a message that item needs an update and a button by the item to trigger the update UI. I can test this with `https://plaid.com/docs/api/sandbox/#sandboxitemreset_login`.
- update the README.md
- add a github workflow which publishes a copy of the container or perhaps the node package.

## Notes:

- [bypass link](https://plaid.com/docs/api/sandbox/#sandboxpublic_tokencreate) in sandbox
- [create transaction link](https://plaid.com/docs/api/sandbox/#sandboxtransactionscreate) for sandbox.
- the token exchange only gives the itemid, but not the institutionid?
