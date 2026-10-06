/// Structured log events. Drop-in replacement for the subset of Logary.Message
/// used by the node (eventX, setField), without the Logary/NodaTime dependency.
module Infrastructure.LogEvent

type LogLevel =
    | Verbose = 0
    | Debug = 1
    | Info = 2
    | Warn = 3
    | Error = 4

type Event =
    {
        level: LogLevel
        template: string
        fields: (string * obj) list
    }

/// Start an event from a message template with {placeholders}.
let eventX (template: string) (level: LogLevel) : Event =
    { level = level; template = template; fields = [] }

/// Set the value of a {placeholder}. A later value for the same name wins.
let setField (name: string) (value: 'a) (event: Event) : Event =
    { event with fields = (name, box value) :: event.fields }
