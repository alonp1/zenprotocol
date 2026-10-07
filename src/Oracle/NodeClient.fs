/// Talks to a ZP node: executes the Oracle contract with the Commit command.
module Oracle.NodeClient

open System.Net.Http
open System.Text
open System.Text.Json

let private http = new HttpClient(Timeout = System.TimeSpan.FromSeconds 60.0)

/// Returns the transaction hash. The node signs with the wallet key at `signPath`; the wallet password unlocks it.
let commit (node: string) (contractAddress: string) (messageBody: string) (signPath: string) (password: string) : string =
    let body =
        JsonSerializer.Serialize(
            {| address = contractAddress
               command = "Commit"
               messageBody = messageBody
               options = {| returnAddress = false; sign = signPath |}
               spends = Array.empty<obj>
               password = password |})
    let resp = http.PostAsync(node.TrimEnd('/') + "/wallet/contract/execute", new StringContent(body, Encoding.UTF8, "application/json")).Result
    let text = resp.Content.ReadAsStringAsync().Result
    if not resp.IsSuccessStatusCode then failwithf "node refused the commitment (%d): %s" (int resp.StatusCode) text
    text.Trim().Trim('"')
