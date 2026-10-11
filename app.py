"""Single entry point of the packaged program (it also runs from source: `python app.py`).

  跳帮修改器.exe                    open the trainer window (the launcher starts the background service when needed)
  跳帮修改器.exe --service          the background service itself (started by the launcher, not by hand)
  跳帮修改器.exe <命令> [参数…]       same as jsc.py: status, progression, addCurrency, spawn …  (output goes to the console
                                    of whoever started it, so run this from a terminal)
"""
import sys


def main():
    args = sys.argv[1:]
    if "--service" in args:
        import daemon

        daemon.main()
    elif args and not args[0].startswith("-"):
        import jsc

        sys.exit(jsc.main())
    else:
        import trainer

        trainer.run()


if __name__ == "__main__":
    main()
