# Holds Grok Bot's own window inside this app's window on Windows. Commands arrive on standard input, one per line, and results leave on standard output.
# Electron has no call for moving another app's window, and a PowerShell host adds no dependency or build step.
# Commands: adopt <host> [<bot> <style> <exstyle> <placement>], place <x> <y> <width> <height> <viewHeight>, show, hide (something covers the view), away (the view closed), release, close.
# Results: adopted <bot> <style> <exstyle> <placement>, none, failed, gone, released.
param([switch]$Check)
Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class GrokBotWindow {
	[StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct Placement { public int Length, Flags, ShowCmd; public Point MinPos, MaxPos; public Rect Normal; }

	[DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
	[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr window, int index);
	[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr window, int index, IntPtr value);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
	[DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
	[DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
	[DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
	[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
	[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
	[DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
	[DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
	[DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
	[DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
	[DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wide, IntPtr low);

	const uint CloseMessage = 0x10;
	const int StyleIndex = -16, ExStyleIndex = -20;
	const long Minimized = 0x20000000L, Maximized = 0x01000000L;
	const long Removed = 0x80000000L | 0x00C00000L | 0x00040000L | 0x00080000L | 0x00020000L | 0x00010000L | Minimized | Maximized; // popup, caption, resize frame, system menu, minimize and maximize boxes
	const uint NoSize = 0x1, NoMove = 0x2, NoZOrder = 0x4, NoActivate = 0x10, FrameChanged = 0x20;
	const int Hide = 0, ShowNoActivate = 4, ShowInPlace = 8;
	const uint FirstChild = 5;

	static IntPtr host, bot;
	static long savedStyle, savedExStyle;
	static string savedPlacement = "";
	static bool wanted, hasArea, away;
	static int areaX, areaY, areaWidth, areaHeight, viewHeight, borderSide, borderBottom;

	static void Say(string text) {
		try {
			Console.Out.WriteLine(text);
			Console.Out.Flush();
		} catch (Exception) { }
	}

	static IntPtr FindBot() {
		foreach (Process process in Process.GetProcessesByName("Grok Bot")) {
			try {
				if (process.MainWindowHandle != IntPtr.Zero) { return process.MainWindowHandle; }
			} catch (Exception) { }
		}
		return IntPtr.Zero;
	}

	static string ReadPlacement(IntPtr window) {
		Placement saved = new Placement();
		saved.Length = Marshal.SizeOf(saved);
		GetWindowPlacement(window, ref saved);
		return string.Join(",", new int[] { saved.Flags, saved.ShowCmd, saved.MinPos.X, saved.MinPos.Y, saved.MaxPos.X, saved.MaxPos.Y, saved.Normal.Left, saved.Normal.Top, saved.Normal.Right, saved.Normal.Bottom });
	}

	static void WritePlacement(IntPtr window, string text) {
		string[] values = text.Split(',');
		Placement saved = new Placement();
		saved.Length = Marshal.SizeOf(saved);
		saved.Flags = int.Parse(values[0]);
		// A normal window comes back without taking focus from whatever the person is doing.
		saved.ShowCmd = values[1] == "1" ? ShowNoActivate : int.Parse(values[1]);
		saved.MinPos.X = int.Parse(values[2]);
		saved.MinPos.Y = int.Parse(values[3]);
		saved.MaxPos.X = int.Parse(values[4]);
		saved.MaxPos.Y = int.Parse(values[5]);
		saved.Normal.Left = int.Parse(values[6]);
		saved.Normal.Top = int.Parse(values[7]);
		saved.Normal.Right = int.Parse(values[8]);
		saved.Normal.Bottom = int.Parse(values[9]);
		SetWindowPlacement(window, ref saved);
	}

	// The app's menu bar, when shown, sits above the page inside the window's client area.
	static int PageTop() {
		Rect client;
		GetClientRect(host, out client);
		int top = client.Bottom - viewHeight;
		return top > 1 ? top : 0;
	}

	static void Place(uint flags) {
		if (!hasArea) { return; }
		int top = PageTop();
		SetWindowPos(bot, IntPtr.Zero, areaX - borderSide, areaY + top, areaWidth + 2 * borderSide, areaHeight + borderBottom, flags | NoActivate);
		Rect outer, inner;
		GetWindowRect(bot, out outer);
		GetClientRect(bot, out inner);
		int side = (outer.Right - outer.Left - inner.Right) / 2;
		int bottom = outer.Bottom - outer.Top - inner.Bottom;
		// Grok Bot keeps an invisible resize border, so the window is made that much larger for its page to fill the area.
		if (inner.Right > 0 && inner.Bottom > 0 && (side != borderSide || bottom != borderBottom)) {
			borderSide = side;
			borderBottom = bottom;
			SetWindowPos(bot, IntPtr.Zero, areaX - borderSide, areaY + top, areaWidth + 2 * borderSide, areaHeight + borderBottom, NoActivate);
			GetWindowRect(bot, out outer);
		}
		// Left in place, that border would take clicks meant for what lies beside the area, such as the sidebar's resize handle.
		SetWindowRgn(bot, CreateRectRgn(borderSide, 0, outer.Right - outer.Left - borderSide, outer.Bottom - outer.Top - borderBottom), true);
	}

	static void Restore() {
		if (bot == IntPtr.Zero || !IsWindow(bot)) {
			bot = IntPtr.Zero;
			return;
		}
		SetWindowRgn(bot, IntPtr.Zero, false);
		SetParent(bot, IntPtr.Zero);
		// Minimized and maximized come back through the saved placement, so the app hears about them.
		SetLong(bot, StyleIndex, new IntPtr(savedStyle & ~(Minimized | Maximized)));
		SetLong(bot, ExStyleIndex, new IntPtr(savedExStyle));
		WritePlacement(bot, savedPlacement);
		SetWindowPos(bot, IntPtr.Zero, 0, 0, 0, 0, NoMove | NoSize | NoZOrder | NoActivate | FrameChanged);
		// Hide then show, so the taskbar picks the window up again.
		ShowWindow(bot, Hide);
		ShowWindow(bot, ShowInPlace);
		bot = IntPtr.Zero;
	}

	// The message its own close button sends, so it saves what it normally saves. A window still there after a moment may be asking something, so it goes back on the desktop, where that can be seen.
	static void CloseBot() {
		if (bot != IntPtr.Zero && IsWindow(bot)) {
			ShowWindow(bot, Hide);
			SetParent(bot, IntPtr.Zero);
			PostMessage(bot, CloseMessage, IntPtr.Zero, IntPtr.Zero);
			for (int waited = 0; waited < 3000 && IsWindow(bot); waited += 50) { Thread.Sleep(50); }
		}
		Restore();
	}

	static void Adopt(string[] words) {
		if (bot == IntPtr.Zero || !IsWindow(bot)) {
			if (words.Length > 5) {
				// A restarted helper picks up the window its predecessor held.
				bot = new IntPtr(long.Parse(words[2]));
				savedStyle = long.Parse(words[3]);
				savedExStyle = long.Parse(words[4]);
				savedPlacement = words[5];
				if (!IsWindow(bot)) {
					bot = IntPtr.Zero;
					Say("none");
					return;
				}
			} else {
				bot = FindBot();
				if (bot == IntPtr.Zero) {
					Say("none");
					return;
				}
				savedStyle = GetLong(bot, StyleIndex).ToInt64();
				savedExStyle = GetLong(bot, ExStyleIndex).ToInt64();
				savedPlacement = ReadPlacement(bot);
				// A minimized window's page stays hidden, and it would stay blank once inside. Bring it back first.
				if ((savedStyle & (Minimized | Maximized)) != 0) {
					ShowWindow(bot, ShowNoActivate);
					Thread.Sleep(800);
				}
			}
		}
		// Hidden until the page says where it goes.
		wanted = false;
		hasArea = false;
		away = false;
		ShowWindow(bot, Hide);
		host = new IntPtr(long.Parse(words[1]));
		// Not WS_CHILD: as a child window, a click never gives the app keyboard focus.
		SetLong(bot, StyleIndex, new IntPtr(GetLong(bot, StyleIndex).ToInt64() & ~Removed));
		if (SetParent(bot, host) == IntPtr.Zero) {
			Restore();
			Say("failed");
			return;
		}
		SetWindowPos(bot, IntPtr.Zero, 0, 0, 0, 0, NoMove | NoSize | NoZOrder | NoActivate | FrameChanged);
		Say("adopted " + bot.ToInt64() + " " + savedStyle + " " + savedExStyle + " " + savedPlacement);
	}

	static bool Handle(string line) {
		string[] words = line.Split(' ');
		if (words[0] == "release") {
			Restore();
			Say("released");
			return false;
		}
		if (words[0] == "close") {
			CloseBot();
			Say("released");
			return false;
		}
		if (words[0] == "adopt") {
			Adopt(words);
			return true;
		}
		if (bot == IntPtr.Zero) { return true; }
		if (words[0] == "place") {
			areaX = int.Parse(words[1]);
			areaY = int.Parse(words[2]);
			areaWidth = int.Parse(words[3]);
			areaHeight = int.Parse(words[4]);
			viewHeight = int.Parse(words[5]);
			hasArea = true;
			Place(0);
		} else if (words[0] == "show") {
			wanted = hasArea;
		} else if (words[0] == "hide") {
			wanted = false;
		} else if (words[0] == "away") {
			wanted = false;
			away = true;
			ShowWindow(bot, Hide);
		}
		return true;
	}

	// Runs often: nothing tells this process when these change, and each one has been seen to happen.
	static void Guard() {
		if (bot == IntPtr.Zero) { return; }
		if (!IsWindow(bot)) {
			bot = IntPtr.Zero;
			Say("gone");
			return;
		}
		if (!IsWindow(host)) { return; }
		if (IsWindowVisible(bot) != wanted) { ShowWindow(bot, wanted ? ShowInPlace : Hide); }
		if (!wanted) { return; }
		// Grok Bot's own minimize and maximize buttons still work from inside.
		if (IsIconic(bot) || IsZoomed(bot)) {
			ShowWindow(bot, ShowNoActivate);
			Place(FrameChanged);
		}
		// This app's hidden input layer can rise above Grok Bot, and then it takes every click.
		if (GetWindow(host, FirstChild) != bot) { SetWindowPos(bot, IntPtr.Zero, 0, 0, 0, 0, NoMove | NoSize | NoActivate); }
		// Grok Bot's top bar can still drag its window.
		Point origin = new Point();
		ClientToScreen(host, ref origin);
		Rect now;
		GetWindowRect(bot, out now);
		if (now.Left != origin.X + areaX - borderSide || now.Top != origin.Y + areaY + PageTop()) { Place(0); }
	}

	public static void Run() {
		SetThreadDpiAwarenessContext(new IntPtr(-4));
		ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
		Thread reader = new Thread(() => {
			string text;
			while ((text = Console.In.ReadLine()) != null) { lines.Enqueue(text); }
			// The app has gone, so give the window back.
			lines.Enqueue("release");
		});
		reader.IsBackground = true;
		reader.Start();
		while (true) {
			string line;
			while (lines.TryDequeue(out line)) {
				try {
					if (!Handle(line)) { return; }
				} catch (Exception) { }
			}
			// Grok Bot shows itself when someone opens it from the Start menu or a notification. With its view closed nothing here would show it, so it goes back to the desktop.
			if (away && IsWindowVisible(bot)) {
				lines.Enqueue("release");
				continue;
			}
			try { Guard(); } catch (Exception) { }
			Thread.Sleep(30);
		}
	}
}
'@
if ($Check) {
	"ok"
	exit 0
}
[GrokBotWindow]::Run()
